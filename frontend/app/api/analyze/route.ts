// app/api/analyze/route.ts
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
	// 1. Validate API Keys
	const apiKeys = getApiKeys();
	if (apiKeys.length === 0) {
		return NextResponse.json({ error: "Missing GOOGLE_API_KEYS or GOOGLE_API_KEY in .env.local" }, { status: 500 });
	}

	const { image } = await request.json(); // Expects full base64 string (data:image/png;base64,...)

	if (!image) {
		return NextResponse.json({ error: "No image provided" }, { status: 400 });
	}

	// 2. Prepare Image for Gemini
	const base64Data = image.split(",")[1]; // Remove header
	const mimeType = image.split(";")[0].split(":")[1]; // Extract "image/png"

	const prompt = `
    Analyze this pipe network image. It describes a hydraulic network problem.

    **Step 1: Detect Mode (Classification)**
    Classify the problem into one of two MAIN categories:

    **MODE A: "darcy" (Physics Simulation)**
    - The goal is to FIND FLOWS ($Q$) based on pipe properties.
    - **Type 1**: Pipes have derived properties like Length ($L$), Diameter ($D$), Friction ($f$).
    - **Type 2**: Pipes have resistance values directly given as $r=\dots$ or $K=\dots$.
    - *Key Indicators:* You see "L=100m" OR "r=2", "K=5". Nodes have demand values (inflows/outflows).

    **MODE B: "puzzle" (Missing Values)**
    - The goal is to FIND MISSING VALUES ($Q$ or $h_f$) based on given values.
    - Specific flows or head losses are provided on some pipes (e.g., "$Q=20$", "$h_f=10$").
    - Other values are marked with "?" or variables.
    - *Key Indicator:* You see "$Q=?$" or "$h_f=?$" or mixed known/unknown flows.

    **Step 2: Extract Data**
    Return ONLY a JSON object with this EXACT schema:
    {
      "method": "puzzle" | "darcy",
      "nodes": [{"id": "string", "demand": number | null}], 
      "pipes": [
        {
          "id": "string", 
          "start_node": "string", 
          "end_node": "string", 
          "length": number | null, 
          "diameter": number | null, 
          "roughness": number | null, 
          "resistance_k": number | null,
          "given_flow": number | null,
          "given_head_loss": number | null
        }
      ]
    }
    Rules:
    - Demand: Positive (+) for Inflow (Source), Negative (-) for Outflow (Load). **If a node discharge is unknown (e.g. Q_B = ?), set demand to null.**
    - length: Pipe length. Should be null if not explicitly given.
    - diameter: Pipe diameter. Should be null if not explicitly given.
    - roughness: Darcy friction factor 'f'. If unspecified, use 0.02.
    - resistance_k: If the image provides K, R, or r (Type 2), map it here. If image uses L/D/f (Type 1), leave null.
    
    **Problem Types:**
    1. **Type 1 (Darcy Simulation):** L, D, f are given. resistance_k is null.
    2. **Type 2 (Darcy Simulation):** r or K values given. Map to resistance_k. L, D can be null.
    3. **Puzzle Mode:** Q or hf given. Map to given_flow / given_head_loss. method="puzzle".
      - Common formats: K=500, R=1000, r=200 (units are s²/m⁵ typically)
    - given_flow / given_head_loss: ONLY for "puzzle" mode. Extract values if given (e.g. Q1=30 -> given_flow: 30). Leave null if unknown (Q=?).
    - Units: Assume SI (meters) unless marked otherwise.
    - If you see both f (friction factor) AND K (resistance), include both values.
    - IMPORTANT: If length/diameter are not shown, default to 1 for simplified problem types.
    `;

	// Try each API key until one works
	let lastError: any = null;
	for (let i = 0; i < apiKeys.length; i++) {
		const apiKey = apiKeys[i];
		try {
			console.log(`🔑 Trying API key ${i + 1}/${apiKeys.length}...`);

			const genAI = new GoogleGenerativeAI(apiKey);
			const model = genAI.getGenerativeModel({
				model: "gemini-2.5-flash",
				generationConfig: { responseMimeType: "application/json" },
			});

			const result = await model.generateContent([
				prompt,
				{
					inlineData: {
						data: base64Data,
						mimeType: mimeType,
					},
				},
			]);

			const responseText = result.response.text();
			console.log(`✅ Gemini Response (key ${i + 1}):`, responseText.substring(0, 100) + "...");

			const data = JSON.parse(responseText);
			return NextResponse.json(data);
		} catch (error: any) {
			console.error(`❌ API key ${i + 1} failed:`, error.message);
			lastError = error;
			// Continue to next key
		}
	}

	// All keys failed
	console.error("❌ All API keys exhausted");
	return NextResponse.json({ error: lastError?.message || "All API keys failed" }, { status: 500 });
}
