import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Get all API keys from env (supports KEY1, KEY2, KEY3 format or comma-separated)
function getApiKeys(): string[] {
	const keys: string[] = [];

	// Check for numbered keys: GOOGLE_API_KEY1, GOOGLE_API_KEY2, etc.
	for (let i = 1; i <= 10; i++) {
		const key = process.env[`GOOGLE_API_KEY${i}`];
		if (key && key.trim()) {
			keys.push(key.trim());
		}
	}

	// Fallback to comma-separated or single key
	if (keys.length === 0) {
		const fallback = process.env.GOOGLE_API_KEYS || process.env.GOOGLE_API_KEY || "";
		keys.push(
			...fallback
				.split(",")
				.map((k) => k.trim())
				.filter((k) => k.length > 0)
		);
	}

	return keys;
}

export async function POST(request: Request) {
	const apiKeys = getApiKeys();
	if (apiKeys.length === 0) {
		return NextResponse.json({ error: "Missing API Key" }, { status: 500 });
	}

	const { networkData, solution } = await request.json();

	// Build pipe info string for clearer context
	const pipeInfo = networkData.pipes
		.map(
			(p: any) =>
				`Pipe ${p.id}: ${p.start_node}→${p.end_node}, L=${p.length || 1}, D=${p.diameter || 1}, f=${p.roughness}, K=${
					p.resistance_k || "calculated"
				}`
		)
		.join("\n");

	const nodeInfo = networkData.nodes
		.map((n: any) => {
			if (n.demand === null || n.demand === undefined) return `Node ${n.id}: demand=UNKNOWN (?)`;
			return `Node ${n.id}: demand=${n.demand > 0 ? "+" : ""}${n.demand} m³/s (${
				n.demand > 0 ? "inflow/source" : n.demand < 0 ? "outflow/demand" : "junction"
			})`;
		})
		.join("\n");

	const resultsInfo =
		solution.results
			?.map((r: any) => `Pipe ${r.pipe_id}: Q=${r.flow >= 0 ? "+" : ""}${r.flow} m³/s, K=${r.K}, h_f=${r.head_loss} m`)
			.join("\n") || "No results";

	const nodeResultsInfo =
		solution.node_results
			?.filter((n: any) => n.is_solved)
			.map((n: any) => `Node ${n.node_id}: Found Net Discharge = ${n.demand} m³/s`)
			.join("\n") || "";

	// --- DETERMINE MODE ---
	const isPuzzle = networkData.method === "puzzle";
	const methodTitle = isPuzzle ? "Hydraulic Network Puzzle Solver" : "Hardy Cross Method";

	// --- IMPROVED PROMPT ---
	// Base context
	let prompt = `
You are an expert hydraulics engineer explaining the ${methodTitle} step-by-step.

**NETWORK DATA:**
Pipes:
${pipeInfo}
${isPuzzle ? "(Note: Some flows or head losses are given as 'knowns', unknowns are to be found)" : ""}

Nodes:
${nodeInfo}

**SOLVER RESULTS:**
**Pipes:**
${resultsInfo}

**Nodes (Calculated):**
${nodeResultsInfo}

**Sign Convention:**
- Positive flow (+Q): flow from Start node → End node (as defined in pipe)
- Negative flow (-Q): flow from End node → Start node (opposite direction)

---
`;

	if (isPuzzle) {
		prompt += `
Write a comprehensive step-by-step solution for this "missing values" puzzle. Follow this format:

## 1. Problem Setup
- Identify which values (Q or h_f) are **Given** and which are **Unknown**.
- State the fundamental laws used:
  - **Node Balance (KCL):** $\\sum Q_{in} = \\sum Q_{out}$ (Continuity equation)
  - **Loop Balance (KVL):** $\\sum h_f = 0$ around any closed loop.

## 2. Logical Deduction Steps
- Walk through the network logically to find the unknowns.
- **Node Analysis:** Look for nodes where all but one flow is known. Solve for the unknown flow using $\\sum Q = 0$.
- **Loop Analysis:** If head losses are involved, look for loops where all but one head loss is known (or calculable). Use $\\sum h_f = 0$ to find the missing head loss.
- Explain each calculation clearly (e.g., "At Node A, we know flow in from X and out to Y, so the flow to Z must be...").

## 3. Final Results Verification
- Summarize the calculated values.
- Verify that these values satisfy continuity at all nodes.
`;
	} else {
		prompt += `
Write a comprehensive step-by-step solution following this EXACT format:

## 1. Problem Setup

**Network Description:**
- List all pipes with their properties (ID, start→end nodes, K values)
- List all nodes with their demands

**Key Formulas (Darcy-Weisbach):**
- Head loss: $h_f = K \\cdot Q \\cdot |Q|$
- Correction: $\\Delta Q = -\\frac{\\sum h_f}{\\sum 2K|Q|}$
- If K is calculated: $K = \\frac{8fL}{\\pi^2 g D^5}$

## 2. Initial Flow Assumption
- Explain how initial flows were distributed to satisfy continuity at nodes.
- Show the assumed flows for each pipe with correct signs.

## 3. Loop Identification
- Identify the loops in the network.
- For each loop, list the pipes and direction (CW/CCW).

## 4. Iteration Calculations
- Show the calculation of $\\Delta Q$ for the first iteration using a table if helpful.
- **Correction:** $\\Delta Q = -\\frac{\\sum h_f}{\\sum 2K|Q|}$
- State how many iterations were needed to converge.

## 5. Final Results
- List Final Flow, Velocity, and Head Loss for each pipe.
- Briefly interpret the flow pattern.

## 6. Verification
- Show that continuity is satisfied at key nodes.
- Show that head loss sums to zero in loops.
`;
	}

	// Try each API key until one works

	let lastError: any = null;
	for (let i = 0; i < apiKeys.length; i++) {
		const apiKey = apiKeys[i];
		try {
			console.log(`🔑 Explain: Trying API key ${i + 1}/${apiKeys.length}...`);

			const genAI = new GoogleGenerativeAI(apiKey);
			const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

			// Start Stream
			const result = await model.generateContentStream(prompt);

			// Pipe Stream to Client
			const stream = new ReadableStream({
				async start(controller) {
					try {
						for await (const chunk of result.stream) {
							const chunkText = chunk.text();
							controller.enqueue(new TextEncoder().encode(chunkText));
						}
						controller.close();
					} catch (err) {
						console.error("Stream error:", err);
						controller.error(err);
					}
				},
			});

			console.log(`✅ Explain: Streaming with key ${i + 1}`);
			return new NextResponse(stream, {
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		} catch (error: any) {
			console.error(`❌ Explain: API key ${i + 1} failed:`, error.message);
			lastError = error;
			// Continue to next key
		}
	}

	// All keys failed
	console.error("❌ Explain: All API keys exhausted");
	return NextResponse.json({ error: "Stream Failed: " + (lastError?.message || "All API keys failed") }, { status: 500 });
}
