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
		.map(
			(n: any) =>
				`Node ${n.id}: demand=${n.demand > 0 ? "+" : ""}${n.demand} m³/s (${
					n.demand > 0 ? "inflow/source" : n.demand < 0 ? "outflow/demand" : "junction"
				})`
		)
		.join("\n");

	const resultsInfo =
		solution.results
			?.map((r: any) => `Pipe ${r.pipe_id}: Q=${r.flow >= 0 ? "+" : ""}${r.flow} m³/s, K=${r.K}, h_f=${r.head_loss} m`)
			.join("\n") || "No results";

	// --- IMPROVED PROMPT ---
	const prompt = `
You are an expert hydraulics engineer explaining the Hardy Cross method step-by-step.

**NETWORK DATA:**
Pipes:
${pipeInfo}

Nodes:
${nodeInfo}

**SOLVER RESULTS:**
${resultsInfo}

Converged: ${solution.converged}
Iterations: ${solution.iterations}

**Sign Convention:**
- Positive flow (+Q): flow from Start node → End node (as defined in pipe)
- Negative flow (-Q): flow from End node → Start node (opposite direction)

---

Write a comprehensive step-by-step solution following this EXACT format:

## 1. Problem Setup

**Network Description:**
- List all pipes with their properties (ID, start→end nodes, K values)
- List all nodes with their demands

**Key Formulas (Darcy-Weisbach):**
- Head loss: $h_f = K \\cdot Q \\cdot |Q|$ where K is resistance coefficient
- Correction: $\\Delta Q = -\\frac{\\sum h_f}{\\sum 2K|Q|}$
- If K is calculated: $K = \\frac{8fL}{\\pi^2 g D^5}$

## 2. Initial Flow Assumption

Explain how initial flows were distributed to satisfy continuity at nodes.
Show the assumed flows for each pipe with correct signs.

## 3. Loop Identification

Identify the loops in the network. For each loop, list:
- The pipes that form the loop
- The direction of traversal (clockwise or counterclockwise)

## 4. Iteration Calculations

### Iteration 1

For each loop, create a calculation table:

| Pipe | Q (m³/s) | K | h_f = K·Q·|Q| | 2K|Q| |
|------|----------|---|---------------|-------|
| ... | ... | ... | ... | ... |
| **Sum** | | | Σh_f = ... | Σ2K|Q| = ... |

**Correction:** $\\Delta Q = -\\frac{\\Sigma h_f}{\\Sigma 2K|Q|} = ...$

**Updated flows after Iteration 1:**
List the new flow values for each pipe.

*(Continue showing iterations until convergence if helpful)*

## 5. Final Results

| Pipe | Final Flow (m³/s) | Direction | Velocity (m/s) | Head Loss (m) |
|------|-------------------|-----------|----------------|---------------|
| ... | ... | ... | ... | ... |

**Direction interpretation:**
- Positive flow: Start → End as defined
- Negative flow: End → Start (reversed)

## 6. Verification

Show that:
1. Continuity is satisfied at each node (ΣQ_in = ΣQ_out)
2. Head loss around each loop sums to approximately zero

## 7. Physical Interpretation

Briefly describe the flow pattern in plain language. Which paths carry the most flow? Why?
`;

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
