from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import math
import networkx as nx

app = FastAPI()

# --- CORS SETUP ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GRAVITY = 9.81
PI = math.pi

# --- MODELS ---
class PipeInput(BaseModel):
    id: str
    start_node: str
    end_node: str
    length: float
    diameter: float
    roughness: float # Darcy f

class NodeInput(BaseModel):
    id: str
    demand: float # +ve = Inflow (Source), -ve = Outflow (Load)

class NetworkInput(BaseModel):
    pipes: List[PipeInput]
    nodes: List[NodeInput]

# --- HELPER: CALCULATE K (RESISTANCE) ---
def calculate_k(pipe: PipeInput):
    # Darcy-Weisbach: h_f = K * Q^2
    # K = (8 * f * L) / (pi^2 * g * D^5)
    if pipe.diameter == 0: return 1e12 # Prevent div/0
    return (8 * pipe.roughness * pipe.length) / (PI**2 * GRAVITY * pipe.diameter**5)

# --- CRITICAL: INITIALIZATION ALGORITHM ---
def initialize_flows_path_method(nodes, pipes):
    """
    Satisfies continuity (Sigma Q = 0) by pushing demand from Sources to Sinks
    along the shortest paths.
    """
    G = nx.Graph()
    # Initialize all flows to 0.0
    pipe_flows = {p.id: 0.0 for p in pipes}
    
    # Map for quick lookup
    pipe_lookup = {}
    for p in pipes:
        # We store both directions for pathfinding lookup
        pipe_lookup[(p.start_node, p.end_node)] = p.id
        pipe_lookup[(p.end_node, p.start_node)] = p.id
        G.add_edge(p.start_node, p.end_node, weight=1) # Unweighted for BFS (fewest pipes)

    # Separate Sources (+) and Sinks (-)
    # We define "Residual Demand" needed at each node
    node_balances = {n.id: n.demand for n in nodes} 

    # Sinks need water (negative balance). Sources have water (positive).
    # We iterate until all nodes are balanced (approx 0).
    
    # 1. Identify all nodes that need water (Sinks)
    sinks = [nid for nid, bal in node_balances.items() if bal < -1e-9]
    sources = [nid for nid, bal in node_balances.items() if bal > 1e-9]

    if not sinks and not sources:
        return pipe_flows # No flow needed

    for sink in sinks:
        needed = -node_balances[sink] # How much this sink needs
        if needed <= 0: continue

        # Try to pull water from sources
        for source in sources:
            available = node_balances[source]
            if available <= 0: continue

            # How much can we move?
            amount = min(needed, available)

            try:
                # Find path from Source -> Sink
                path = nx.shortest_path(G, source, sink)
                
                # Push flow along this path
                for i in range(len(path) - 1):
                    u, v = path[i], path[i+1]
                    p_id = pipe_lookup.get((u,v))
                    
                    # Find pipe definition to check direction
                    # If pipe is defined A->B, and we flow A->B, add Flow.
                    # If we flow B->A, subtract Flow.
                    # We need the actual pipe object to know its "definition"
                    # But we only have ID here. We need to look it up later or trust consistent updates.
                    
                    # Simpler: We just store the flow relative to the pipe definition.
                    # We need to look up the pipe object to see its start/end.
                    # Let's rely on the pipe_flows dict storing Signed Flow.
                    
                    # Check definition:
                    # We iterate pipes later, so let's check definition now
                    # This is slow but safe.
                    pipe_def = next(p for p in pipes if p.id == p_id)
                    
                    if pipe_def.start_node == u and pipe_def.end_node == v:
                        pipe_flows[p_id] += amount
                    else:
                        pipe_flows[p_id] -= amount
                
                # Update Balances
                node_balances[source] -= amount
                node_balances[sink] += amount
                available -= amount
                needed -= amount
                
                if needed < 1e-9: break # Sink satisfied
                
            except nx.NetworkXNoPath:
                continue # Try next source

    return pipe_flows

# --- MAIN SOLVER ---
def solve_network(data: NetworkInput):
    # 1. Setup
    pipes_map = {p.id: p for p in data.pipes}
    
    # 2. Build Graph for Loop Detection
    G_cycle = nx.Graph()
    for p in data.pipes:
        G_cycle.add_edge(p.start_node, p.end_node, id=p.id)
    
    # Find Loops (Cycle Basis)
    try:
        loops = nx.cycle_basis(G_cycle)
    except:
        return {"error": "Could not find closed loops in network."}

    if not loops:
        # If no loops (branched network), initialization IS the solution.
        pass

    # 3. Valid Initialization (Crucial Fix)
    pipe_flows = initialize_flows_path_method(data.nodes, data.pipes)
    pipe_k = {p.id: calculate_k(p) for p in data.pipes}
    
    history = []
    
    # 4. Hardy Cross Iterations
    MAX_ITER = 50
    TOLERANCE = 1e-4 # Convergence threshold

    for iter_num in range(MAX_ITER):
        max_correction = 0
        iteration_log = {"iteration": iter_num + 1, "loops": []}
        
        # We must apply corrections simultaneously or sequentially?
        # Sequential (applying immediately) is standard for Hardy Cross code usually.
        
        for loop_nodes in loops:
            sum_hl = 0.0
            sum_deriv = 0.0
            loop_data_for_update = []
            
            # Walk the loop A->B->C->A
            for i in range(len(loop_nodes)):
                u = loop_nodes[i]
                v = loop_nodes[(i + 1) % len(loop_nodes)]
                
                # Identify pipe and direction relative to loop
                edge_data = G_cycle.get_edge_data(u, v)
                p_id = edge_data['id']
                pipe_def = pipes_map[p_id]
                
                # Direction: 
                # +1 if loop traverses u->v AND pipe is u->v
                # -1 if loop traverses u->v BUT pipe is v->u
                loop_dir = 1 if pipe_def.start_node == u else -1
                
                Q = pipe_flows[p_id]
                K = pipe_k[p_id]
                
                # Head Loss in the pipe (Standard formula: h = K * Q * |Q|)
                # But we need HL relative to the LOOP direction.
                # If flow is WITH loop, HL is positive. If AGAINST, negative.
                
                # Real Flow relative to Loop = Q * loop_dir
                Q_relative = Q * loop_dir
                
                # HL_relative = K * Q_relative * |Q_relative|
                hl_rel = K * Q_relative * abs(Q_relative)
                
                # Derivative is always positive: 2 * K * |Q_relative|
                deriv = 2 * K * abs(Q_relative)
                
                sum_hl += hl_rel
                sum_deriv += deriv
                
                loop_data_for_update.append({"p_id": p_id, "loop_dir": loop_dir})

            # Calculate Correction Delta Q
            if sum_deriv < 1e-12:
                delta_Q = 0
            else:
                # Formula: Delta = - Sum(HL) / Sum(Deriv)
                delta_Q = -sum_hl / sum_deriv

            # Store stats
            iteration_log["loops"].append({
                "nodes": loop_nodes,
                "delta_Q": delta_Q,
                "sum_hl": sum_hl
            })

            # Apply Correction
            if abs(delta_Q) > max_correction:
                max_correction = abs(delta_Q)

            for item in loop_data_for_update:
                p_id = item['p_id']
                loop_dir = item['loop_dir']
                
                # Update flow
                # If loop direction matches pipe definition, we ADD delta
                # If loop is against pipe definition, we SUBTRACT delta (which is adding delta * -1)
                pipe_flows[p_id] += delta_Q * loop_dir

        history.append(iteration_log)
        
        if max_correction < TOLERANCE:
            break

    # 5. Format Output
    results = []
    for p_id, flow in pipe_flows.items():
        results.append({
            "pipe_id": p_id,
            "flow": round(flow, 5),
            "velocity": round(4 * abs(flow) / (PI * pipes_map[p_id].diameter**2), 4),
            "head_loss": round(pipe_k[p_id] * flow * abs(flow), 4)
        })

    return {"converged": max_correction < TOLERANCE, "results": results, "history": history}

@app.post("/solve")
async def solve_endpoint(data: NetworkInput):
    try:
        return solve_network(data)
    except Exception as e:
        print("Backend Error:", str(e))
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)