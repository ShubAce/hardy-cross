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
    length: Optional[float] = 1.0
    diameter: Optional[float] = 1.0
    roughness: Optional[float] = 0.02
    resistance_k: Optional[float] = None
    given_flow: Optional[float] = None       # New field for Puzzle Mode
    given_head_loss: Optional[float] = None  # New field for Puzzle Mode

class NodeInput(BaseModel):
    id: str
    demand: Optional[float] = None  # float for known, None for unknown (?)

class NetworkInput(BaseModel):
    method: Optional[str] = "darcy"  # "darcy" or "puzzle"
    pipes: List[PipeInput]
    nodes: List[NodeInput]

# --- ROBUSTNESS CHECKS ---
def validate_and_fix_network(nodes: List[NodeInput], pipes: List[PipeInput], method: str = "darcy") -> Tuple[List[NodeInput], List[PipeInput]]:
    """
    Validates and fixes the network data to ensure it's physically solvable.
    """
    for p in pipes:
        if method == "darcy":
            # Defaults for simulation mode
            if p.length is None or p.length <= 0: p.length = 1.0
            if p.diameter is None or p.diameter <= 0: p.diameter = 1.0
            if p.roughness is None or p.roughness <= 0: p.roughness = 0.02
        
        # Ensure ID exists
        if not p.id: p.id = f"{p.start_node}-{p.end_node}"

    # 2. CONTINUITY CHECK (Only for Darcy Mode where all demands must be known)
    if method == "darcy":
        # Fill missing demands with 0
        for n in nodes:
            if n.demand is None: n.demand = 0.0

        total_demand = sum(n.demand for n in nodes)
        if abs(total_demand) > 1e-6:
            # Balance the network
            source_nodes = [n for n in nodes if n.demand > 0]
            if source_nodes:
                max_node = max(source_nodes, key=lambda n: n.demand)
            elif nodes:
                max_node = max(nodes, key=lambda n: abs(n.demand))
            else:
                return nodes, pipes # Empty nodes list
            
            max_node.demand -= total_demand
            print(f"⚠️ Balanced network at node '{max_node.id}' by {-total_demand:.2f}")

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

def solve_puzzle_network(nodes, pipes):
    """
    Solves for missing Pipe Q, Pipe hf, AND Node Demands using Mass/Energy Balance.
    Non-iterative, logic-based solver.
    """
    # 1. Setup State
    solved_flows = {} # pipe_id -> float
    solved_hl = {}    # pipe_id -> float
    solved_demands = {} # node_id -> float
    
    # Pre-fill knowns
    for p in pipes:
        if p.given_flow is not None: solved_flows[p.id] = p.given_flow
        if p.given_head_loss is not None: solved_hl[p.id] = p.given_head_loss
        
    for n in nodes:
        if n.demand is not None: solved_demands[n.id] = n.demand

    # Build Graph Helper
    adj = {n.id: [] for n in nodes}
    for p in pipes:
        adj[p.start_node].append({"pid": p.id, "dir": 1})  # Leaving start (Out)
        adj[p.end_node].append({"pid": p.id, "dir": -1})   # Entering end (In)

    # Cycle Detection for Head Loss
    G = nx.Graph()
    for p in pipes: G.add_edge(p.start_node, p.end_node, id=p.id)
    try:
        loops = nx.cycle_basis(G)
    except:
        loops = []

    # 2. LOGIC LOOP (Repeat until no new values found)
    changed = True
    iterations = 0
    max_iter = len(pipes) * 2 + 5
    
    while changed and iterations < max_iter:
        changed = False
        iterations += 1

        # --- A. SOLVE NODES (MASS BALANCE) ---
        for node in nodes:
            node_id = node.id
            connections = adj[node_id]
            
            # Check for Pipe Flow Unknowns vs Node Demand Unknowns
            unknown_pipes = [c for c in connections if c['pid'] not in solved_flows]
            demand_known = node_id in solved_demands
            
            if demand_known:
                demand = solved_demands[node_id]
                
                # Case 1: Demand Known, 1 Pipe Unknown -> Solve Pipe
                if len(unknown_pipes) == 1:
                    # Balance: Sum(In) + Demand = Sum(Out)
                    # Or: Sum(Q_in) - Sum(Q_out) + Demand = 0
                    
                    sum_in = sum(solved_flows[c['pid']] for c in connections if c['pid'] in solved_flows and c['dir'] == -1)
                    sum_out = sum(solved_flows[c['pid']] for c in connections if c['pid'] in solved_flows and c['dir'] == 1)
                    
                    # Target equation: (sum_in + Q_unk_in) - (sum_out + Q_unk_out) + demand = 0
                    unk = unknown_pipes[0]
                    
                    # If unk is 'In' (dir=-1), term is +Q
                    # If unk is 'Out' (dir=1), term is -Q
                    # Q * (-dir) = sum_out - sum_in - demand
                    
                    rhs = sum_out - sum_in - demand
                    unk_coeff = -unk['dir'] # If In(-1) -> 1. If Out(1) -> -1.
                    
                    solved_q = rhs / unk_coeff
                    solved_flows[unk['pid']] = solved_q
                    changed = True
            
            else:
                # Case 2: Demand Unknown, All Pipes Known -> Solve Demand
                if len(unknown_pipes) == 0:
                    # Demand = Sum(Out) - Sum(In)
                    sum_in = sum(solved_flows[c['pid']] for c in connections if c['dir'] == -1)
                    sum_out = sum(solved_flows[c['pid']] for c in connections if c['dir'] == 1)
                    
                    calc_demand = sum_out - sum_in
                    solved_demands[node_id] = calc_demand
                    changed = True

        # --- B. SOLVE HEAD LOSS (LOOP BALANCE) ---
        for loop in loops:
            # Gather pipe info for loop
            loop_pipes = [] # (pipe_id, dir_in_loop)
            
            # Traverse loop u->v
            # If pipe is u->v, dir=1. If v->u, dir=-1.
            # Sum(hf * dir) = 0
            
            valid_loop = True
            unknown_hl_pipes = []
            current_sum = 0
            
            for i in range(len(loop)):
                u, v = loop[i], loop[(i+1)%len(loop)]
                
                # Find connecting pipe
                p_found = None
                p_dir = 0
                for p in pipes:
                    if p.start_node == u and p.end_node == v:
                        p_found = p; p_dir = 1; break
                    if p.start_node == v and p.end_node == u:
                        p_found = p; p_dir = -1; break
                
                if not p_found: 
                    valid_loop = False; break
                
                pid = p_found.id
                
                if pid in solved_hl and pid in solved_flows:
                    # We know magnitude hf. Direction of drop depends on flow.
                    # Drop is in direction of flow.
                    # Term = |hf| * sign(Q) * loop_dir
                    q = solved_flows[pid]
                    mag_hf = abs(solved_hl[pid])
                    flow_sign = 1 if q >= 0 else -1
                    
                    term = mag_hf * flow_sign * p_dir
                    current_sum += term
                elif pid in solved_hl and pid not in solved_flows:
                    # We know hf magnitude but not flow direction? 
                    # Ambiguous without Q. Skip for now.
                    valid_loop = False; break
                else:
                    unknown_hl_pipes.append((pid, p_dir))
            
            if valid_loop and len(unknown_hl_pipes) == 1:
                # Solve for missing HL
                # Sum + term_unk = 0 => term_unk = -Sum
                pid_unk, p_dir_unk = unknown_hl_pipes[0]
                
                # term_unk = hf_signed * p_dir_unk
                # hf_signed = -Sum / p_dir_unk
                
                req_signed_hf = -current_sum / p_dir_unk
                
                # Map back to magnitude and flow direction
                # If we know flow Q, we can verify consistency or set hf mag
                
                if pid_unk in solved_flows:
                    q = solved_flows[pid_unk]
                    flow_sign = 1 if q >= 0 else -1
                    
                    # hf_signed = |hf| * flow_sign
                    # |hf| = hf_signed / flow_sign
                    
                    # If flow_sign is 0, we can't determine hf this way (no friction)
                    # Assuming q!=0
                    if abs(q) > 1e-9:
                        calc_mag = req_signed_hf / flow_sign
                        if calc_mag < 0:
                            # Contradiction: HL opposes flow? Possible if pump? 
                            # Assuming passive pipes, this implies calculation error or bad data.
                            # Just take abs for now for puzzle logic.
                            pass
                        
                        solved_hl[pid_unk] = abs(calc_mag)
                        changed = True

    # 3. Format Output
    pipe_results = []
    for p in pipes:
        q = solved_flows.get(p.id, None)
        hf = solved_hl.get(p.id, None)
        
        res = {
            "pipe_id": p.id,
            "start_node": p.start_node,
            "end_node": p.end_node,
            "flow": round(q, 2) if q is not None else 0,
            "head_loss": round(hf, 2) if hf is not None else 0,
            "velocity": 0.0,
            "flow_direction": "unknown",
            "reynolds": 0,
            "K": 0,
            "K_source": "puzzle"
        }
        if q is not None:
             res["flow_direction"] = "start→end" if q >= 0 else "end→start"
        pipe_results.append(res)
        
    node_results = []
    for n in nodes:
        d = solved_demands.get(n.id, None)
        node_results.append({
            "node_id": n.id,
            "demand": round(d, 2) if d is not None else None,
            "is_solved": d is not None and n.demand is None # It was unknown, now known
        })

    return {
        "converged": True,
        "iterations": iterations,
        "results": pipe_results,
        "node_results": node_results, # New field
        "history": []
    }

def solve_network(data: NetworkInput):
    """
    Solve the pipe network using the Hardy Cross iterative method.
    """
    # 1. VALIDATION & DATA PREPARATION
    # Pass 'method' to let validation know if it should be strict
    nodes, pipes = validate_and_fix_network(data.nodes.copy(), data.pipes.copy(), method=data.method)
    pipes_map = {p.id: p for p in pipes}

    if data.method == "puzzle":
        return solve_puzzle_network(nodes, pipes)

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
            "start_node": pipe.start_node,
            "end_node": pipe.end_node,
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