import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export async function POST(request: Request) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing API Key" }, { status: 500 });
  }

  try {
    const { networkData, solution } = await request.json();

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // --- REVISED PROMPT: DIRECT & TECHNICAL ---
    const prompt = `
    You are an automated engineering solver. Provide a rigorous, step-by-step solution for the Hardy Cross method based on the data provided. 
    
    **Constraints:**
    - Do NOT use conversational filler (e.g., "Let's look at," "Hello student").
    - Be direct and objective.
    - Use clear Markdown formatting.
    
    **INPUT DATA:**
    - Network Parameters: ${JSON.stringify(networkData)}
    - Solver Output: ${JSON.stringify(solution)}

    **REQUIRED OUTPUT FORMAT:**

    ## 1. Problem Statement & Parameters
    Create a markdown table summarizing the pipe properties used:
    | Pipe ID | Length (L) | Diameter (D) | Roughness | Assumed Initial Flow |
    |---|---|---|---|---|
    (Fill with data)

    ## 2. Theoretical Basis
    State the formulas used without explanation:
    - Head Loss: $h_f = r Q |Q|^{n-1}$ (where $r$ is the resistance coefficient)
    - Correction Factor: $\\Delta Q = - \\frac{\\sum h_f}{\\sum |n r Q^{n-1}|}$
    - Method: Darcy-Weisbach ($n=2$)

    ## 3. Iteration Analysis
    
    ### Iteration 1
    (Present a detailed calculation table for the FIRST iteration of the PRIMARY loop only).
    | Pipe | Flow ($Q$) | Resistance ($r$) | Head Loss ($h_f$) | $2r|Q|$ |
    |---|---|---|---|---|
    | (Pipe IDs) | ... | ... | ... | ... |
    | **Sum** | | | $\\Sigma h_f = ...$ | $\\Sigma 2r|Q| = ...$ |
    
    **Correction Calculation:**
    $\\Delta Q = \\frac{-( \\Sigma h_f )}{ \\Sigma 2r|Q| } = ...$

    *(State briefly that this process is repeated for all loops until convergence).*

    ## 4. Convergence Summary
    - Total Iterations: (from input)
    - Final Max Error: (from input)

    ## 5. Final Solution
    **Flow Distribution:**
    | Pipe | Final Flow (m³/s) | Velocity (m/s) | Direction |
    |---|---|---|---|
    (List all pipes with final values. Use arrows $\\rightarrow$ to indicate direction based on start/end nodes).

    ## 6. System Behavior Interpretation
    (One concise paragraph describing the physical flow logic, e.g., "The system feeds node C primarily via Pipe 1, while Pipe 2 acts as a balancing line...").
    `;

    // 1. Start Stream
    const result = await model.generateContentStream(prompt);

    // 2. Pipe Stream to Client
    const stream = new ReadableStream({
      async start(controller) {
        for await (const chunk of result.stream) {
          const chunkText = chunk.text();
          controller.enqueue(new TextEncoder().encode(chunkText));
        }
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });

  } catch (error: any) {
    console.error("Explanation Error:", error);
    return NextResponse.json({ error: "Stream Failed" }, { status: 500 });
  }
}