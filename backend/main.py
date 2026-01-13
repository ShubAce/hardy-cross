from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Tuple
import math
import networkx as nx

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Physical Constants
GRAVITY = 9.81  # m/s²
PI = math.pi
KINEMATIC_VISCOSITY = 1.0e-6  # m²/s (water at ~20°C)

# --- ROBUST MODELS ---
class PipeInput(BaseModel):
    id: str
    start_node: str
    end_node: str
    length: float
    diameter: float
    roughness: float  # Darcy friction factor (f)
    resistance_k: Optional[float] = None  # Direct resistance coefficient (K or R)

class NodeInput(BaseModel):
    id: str
    demand: float  # Positive = inflow (source), Negative = outflow (demand)

class NetworkInput(BaseModel):
    pipes: List[PipeInput]
    nodes: List[NodeInput]

# --- ROBUSTNESS CHECKS ---
def validate_and_fix_network(nodes: List[NodeInput], pipes: List[PipeInput]) -> Tuple[List[NodeInput], List[PipeInput]]:
    """
    Validates and fixes the network data to ensure it's physically solvable.
    - Fills missing pipe properties with reasonable defaults
    - Balances node demands for continuity
    
    If length and diameter are not provided, assume both as 1.
    This simplifies the K calculation to just use the friction factor directly
    when K = 8fL/(π²gD⁵) with L=1, D=1 → K ≈ 0.0826 * f
    """
    for p in pipes:
        # If K is directly provided, length and diameter don't matter for calculation
        # But we still set defaults for display purposes
        
        # Fix Length - if not detected, assume 1 (unitless for simplified problems)
        if p.length <= 0 or p.length is None:
            p.length = 1.0
            print(f"ℹ️ Pipe {p.id}: Length not detected, assuming L=1")
        
        # Fix Diameter - if not detected, assume 1 (unitless for simplified problems)
        if p.diameter <= 0 or p.diameter is None:
            p.diameter = 1.0
            print(f"ℹ️ Pipe {p.id}: Diameter not detected, assuming D=1")
        
        # Fix Roughness/Friction factor
        # Typical Darcy friction factors: 0.01 - 0.05
        # If value seems invalid (<=0 or >1), use default
        if p.roughness <= 0 or p.roughness > 1.0:
            p.roughness = 0.02

    # 2. CONTINUITY CHECK (Conservation of Mass)
    # Sum of all demands must equal zero
    total_demand = sum(n.demand for n in nodes)
    
    if abs(total_demand) > 1e-6:
        # Find the source node (largest positive demand) and adjust it
        source_nodes = [n for n in nodes if n.demand > 0]
        if source_nodes:
            max_node = max(source_nodes, key=lambda n: n.demand)
        else:
            # No source found, adjust the node with largest absolute demand
            max_node = max(nodes, key=lambda n: abs(n.demand))
        
        max_node.demand -= total_demand
        print(f"⚠️ Warning: Demands unbalanced by {total_demand:.6f} m³/s. Adjusted node '{max_node.id}'.")

    return nodes, pipes

# --- DARCY-WEISBACH PHYSICS ---
def calculate_resistance_coefficient(pipe: PipeInput) -> float:
    """
    Get the resistance coefficient K for the Darcy-Weisbach equation.
    
    If K is directly provided (resistance_k), use it.
    Otherwise, calculate from friction factor:
    
    Head loss: h_f = K * Q * |Q|
    
    Where K = (8 * f * L) / (π² * g * D⁵)
    
    f = Darcy friction factor (dimensionless)
    L = pipe length (m)
    D = pipe diameter (m)
    g = gravitational acceleration (m/s²)
    """
    # If K is directly provided, use it
    if pipe.resistance_k is not None and pipe.resistance_k > 0:
        return pipe.resistance_k
    
    # Otherwise calculate from friction factor
    f = pipe.roughness  # Darcy friction factor
    L = pipe.length
    D = pipe.diameter
    
    K = (8.0 * f * L) / (PI**2 * GRAVITY * D**5)
    return K

def get_k_source(pipe: PipeInput) -> str:
    """Returns whether K was provided directly or calculated."""
    if pipe.resistance_k is not None and pipe.resistance_k > 0:
        return "provided"
    return "calculated"

def calculate_head_loss(K: float, Q: float) -> float:
    """
    Calculate head loss using Darcy-Weisbach equation.
    h_f = K * Q * |Q|
    
    The sign preserves direction: 
    - Positive Q → Positive head loss in flow direction
    - Negative Q → Negative head loss (loss in opposite direction)
    """
    return K * Q * abs(Q)

def calculate_head_loss_derivative(K: float, Q: float) -> float:
    """
    Calculate derivative of head loss with respect to Q.
    d(h_f)/dQ = d(K * Q * |Q|)/dQ = 2 * K * |Q|
    
    For numerical stability, add small epsilon when Q ≈ 0
    """
    return 2.0 * K * (abs(Q) + 1e-10)

def initialize_flows_robust(nodes: List[NodeInput], pipes: List[PipeInput]) -> Dict[str, float]:
    """
    Initialize pipe flows using path-based flow distribution.
    
    Strategy:
    1. Build a graph of the network
    2. Find shortest paths from sources (positive demand) to sinks (negative demand)
    3. Distribute flow along these paths proportionally
    
    Flow sign convention:
    - Positive flow: from start_node to end_node (as defined in pipe)
    - Negative flow: from end_node to start_node
    """
    G = nx.Graph()
    pipe_flows: Dict[str, float] = {p.id: 0.0 for p in pipes}
    
    # Map edges to pipe IDs for quick lookup
    edge_to_pipe_id: Dict[Tuple[str, str], str] = {}
    for p in pipes:
        G.add_edge(p.start_node, p.end_node, id=p.id)
        edge_to_pipe_id[(p.start_node, p.end_node)] = p.id
        edge_to_pipe_id[(p.end_node, p.start_node)] = p.id

    # Create pipe lookup
    pipe_map = {p.id: p for p in pipes}
    
    # Identify sources (inflow, positive demand) and sinks (outflow, negative demand)
    node_demands = {n.id: n.demand for n in nodes}
    sources = sorted(
        [n_id for n_id, d in node_demands.items() if d > 1e-9],
        key=lambda x: node_demands[x],
        reverse=True
    )
    sinks = sorted(
        [n_id for n_id, d in node_demands.items() if d < -1e-9],
        key=lambda x: node_demands[x]  # Most negative first
    )
    
    # Track remaining capacity at each node
    remaining_supply = {s: node_demands[s] for s in sources}
    remaining_demand = {s: -node_demands[s] for s in sinks}  # Convert to positive

    # Distribute flow from sources to sinks using shortest paths
    for sink_id in sinks:
        demand_needed = remaining_demand[sink_id]
        
        for source_id in sources:
            if demand_needed <= 1e-9:
                break
            
            available_supply = remaining_supply.get(source_id, 0)
            if available_supply <= 1e-9:
                continue
            
            # Flow to transfer
            flow_amount = min(demand_needed, available_supply)
            if flow_amount <= 1e-9:
                continue

            try:
                # Find shortest path from source to sink
                path = nx.shortest_path(G, source_id, sink_id)
                
                # Apply flow along the path
                for i in range(len(path) - 1):
                    u, v = path[i], path[i + 1]
                    pipe_id = edge_to_pipe_id[(u, v)]
                    pipe_def = pipe_map[pipe_id]
                    
                    # Determine flow direction relative to pipe definition
                    if pipe_def.start_node == u:
                        # Flow direction matches pipe definition
                        pipe_flows[pipe_id] += flow_amount
                    else:
                        # Flow direction opposite to pipe definition
                        pipe_flows[pipe_id] -= flow_amount
                
                # Update remaining capacities
                remaining_supply[source_id] -= flow_amount
                remaining_demand[sink_id] -= flow_amount
                demand_needed -= flow_amount
                
            except nx.NetworkXNoPath:
                print(f"⚠️ No path found from {source_id} to {sink_id}")
                continue
    
    return pipe_flows

def solve_network(data: NetworkInput):
    """
    Solve the pipe network using the Hardy Cross iterative method.
    
    The Hardy Cross method corrects flow rates iteratively to satisfy:
    1. Continuity equation at each node (∑Q = 0)
    2. Energy equation around each loop (∑h_f = 0)
    
    For each loop, the correction factor is:
    ΔQ = -∑(h_f) / ∑(dh_f/dQ) = -∑(K·Q·|Q|) / ∑(2·K·|Q|)
    """
    # 1. VALIDATION & DATA PREPARATION
    nodes, pipes = validate_and_fix_network(data.nodes.copy(), data.pipes.copy())
    pipes_map = {p.id: p for p in pipes}

    # 2. BUILD NETWORK GRAPH & DETECT LOOPS
    G = nx.Graph()
    for p in pipes:
        G.add_edge(p.start_node, p.end_node, id=p.id)
    
    # Check connectivity
    if not nx.is_connected(G):
        return {"error": "Network is not fully connected. Check pipe definitions."}
    
    # Find independent loops (cycle basis)
    try:
        loops = nx.cycle_basis(G)
        print(f"📊 Found {len(loops)} independent loop(s)")
    except Exception as e:
        return {"error": f"Could not find valid loops: {str(e)}"}

    if not loops:
        # No loops = tree network, flow is determined by continuity alone
        print("ℹ️ No loops detected - network is a tree (branching) system")

    # 3. INITIALIZE FLOWS (satisfying continuity)
    pipe_flows = initialize_flows_robust(nodes, pipes)
    
    # Calculate resistance coefficients for all pipes
    pipe_K = {p.id: calculate_resistance_coefficient(p) for p in pipes}
    
    # 4. HARDY CROSS ITERATION
    MAX_ITERATIONS = 100
    TOLERANCE = 1e-6  # Convergence tolerance for flow correction
    
    history = []
    converged = False
    
    for iteration in range(MAX_ITERATIONS):
        max_correction = 0.0
        iteration_log = {
            "iteration": iteration + 1,
            "loops": [],
            "pipe_flows": {p_id: round(q, 6) for p_id, q in pipe_flows.items()}
        }
        
        # Process each loop
        for loop_idx, loop_nodes in enumerate(loops):
            sum_head_loss = 0.0
            sum_derivative = 0.0
            loop_pipe_info = []  # Track pipes in this loop for correction
            
            # Traverse the loop (node sequence)
            num_nodes = len(loop_nodes)
            for i in range(num_nodes):
                node_u = loop_nodes[i]
                node_v = loop_nodes[(i + 1) % num_nodes]
                
                # Get pipe connecting these nodes
                edge_data = G.get_edge_data(node_u, node_v)
                if edge_data is None:
                    continue
                    
                pipe_id = edge_data['id']
                pipe_def = pipes_map[pipe_id]
                K = pipe_K[pipe_id]
                Q = pipe_flows[pipe_id]
                
                # Determine loop direction factor
                # If we traverse u->v and pipe is defined start_node->end_node:
                #   - If start_node == u: we're going WITH the pipe definition, factor = +1
                #   - If start_node == v: we're going AGAINST the pipe definition, factor = -1
                if pipe_def.start_node == node_u:
                    loop_direction = 1.0
                else:
                    loop_direction = -1.0
                
                # Flow relative to loop traversal direction
                Q_loop = Q * loop_direction
                
                # Head loss in loop direction (Darcy-Weisbach: h = K·Q·|Q|)
                h_f = calculate_head_loss(K, Q_loop)
                
                # Derivative for Newton-Raphson correction
                dh_dQ = calculate_head_loss_derivative(K, Q_loop)
                
                sum_head_loss += h_f
                sum_derivative += dh_dQ
                
                loop_pipe_info.append({
                    "pipe_id": pipe_id,
                    "loop_direction": loop_direction,
                    "Q": Q,
                    "Q_loop": Q_loop,
                    "h_f": h_f
                })
            
            # Calculate flow correction (Hardy Cross formula)
            if sum_derivative > 1e-12:
                delta_Q = -sum_head_loss / sum_derivative
            else:
                delta_Q = 0.0
            
            # Track maximum correction for convergence check
            if abs(delta_Q) > max_correction:
                max_correction = abs(delta_Q)
            
            # Apply correction to all pipes in the loop
            for pipe_info in loop_pipe_info:
                pipe_id = pipe_info["pipe_id"]
                loop_dir = pipe_info["loop_direction"]
                
                # Correction is applied considering loop direction
                # If we traverse in same direction as pipe definition: add delta_Q
                # If opposite: subtract delta_Q (multiply by loop_direction)
                pipe_flows[pipe_id] += delta_Q * loop_dir
            
            iteration_log["loops"].append({
                "loop_index": loop_idx + 1,
                "nodes": loop_nodes,
                "sum_head_loss": round(sum_head_loss, 6),
                "sum_derivative": round(sum_derivative, 6),
                "delta_Q": round(delta_Q, 6)
            })
        
        iteration_log["max_correction"] = round(max_correction, 8)
        history.append(iteration_log)
        
        # Check convergence
        if max_correction < TOLERANCE:
            converged = True
            print(f"✅ Converged after {iteration + 1} iterations (max ΔQ = {max_correction:.2e})")
            break
    
    if not converged:
        print(f"⚠️ Did not converge after {MAX_ITERATIONS} iterations (max ΔQ = {max_correction:.2e})")

    # 5. COMPUTE FINAL RESULTS
    results = []
    for pipe_id, Q in pipe_flows.items():
        pipe = pipes_map[pipe_id]
        K = pipe_K[pipe_id]
        
        # Velocity: V = Q / A = 4Q / (πD²)
        velocity = (4.0 * abs(Q)) / (PI * pipe.diameter**2)
        
        # Head loss (absolute value for magnitude)
        head_loss = abs(calculate_head_loss(K, Q))
        
        # Reynolds number for reference
        Re = (velocity * pipe.diameter) / KINEMATIC_VISCOSITY if velocity > 0 else 0
        
        results.append({
            "pipe_id": pipe_id,
            "flow": round(Q, 6),
            "flow_direction": "start→end" if Q >= 0 else "end→start",
            "velocity": round(velocity, 4),
            "head_loss": round(head_loss, 4),
            "reynolds": round(Re, 0),
            "K": round(K, 4),
            "K_source": get_k_source(pipe)
        })

    return {
        "converged": converged,
        "iterations": len(history),
        "results": results,
        "history": history
    }

@app.post("/solve")
async def solve_endpoint(data: NetworkInput):
    try:
        return solve_network(data)
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)