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

	const reqBody = await request.json();
	// Support both 'image' (legacy/single) and 'images' (new/multiple) fields
	let imageList: string[] = [];

	if (reqBody.images && Array.isArray(reqBody.images)) {
		imageList = reqBody.images;
	} else if (reqBody.image) {
		imageList = [reqBody.image];
	}

	if (imageList.length === 0) {
		return NextResponse.json({ error: "No images provided" }, { status: 400 });
	}

	// 2. Prepare Images for Gemini
	const imageParts = imageList.map((img) => {
		const base64Data = img.split(",")[1]; // Remove header
		const mimeType = img.split(";")[0].split(":")[1]; // Extract "image/png"
		return {
			inlineData: {
				data: base64Data,
				mimeType: mimeType,
			},
		};
	});

	const prompt = `
    Analyze the provided pipe network image(s). They describe a hydraulic network problem.
    Since there may be multiple images, combine the information from all of them to form a complete network.
    - If images show different parts of the network, merge them based on common node names (A, B, C, etc.).
    - If one image is a text table and another is a diagram, combine the data.

    **Step 1: Detect Problem Type (Classification)**
    Classify the problem into one of these 4 Types:

    **TYPE 1: Flow/Head Identification (Puzzle)**
    - *Goal:* Find missing Q or Head Loss values using simple logic (KCL/KVL) without full iteration.
    - *Indicators:* Some flows/heads are given ($Q=10$, $h=5$), others are unknown ($?$).
    - *Method:* "puzzle"

    **TYPE 2: Classic Hardy Cross (Resistance Given)**
    - *Goal:* Solve network using given resistance factors ($r$ or $K$).
    - *Indicators:* Pipes labeled with $r=2$, $K=4$, or similar. 
    - *Method:* "darcy"

    **TYPE 3: Verification (Suggested Flows Given)**
    - *Goal:* Verify or correct a set of assumed/suggested discharges.
    - *Indicators:* A table or list of "Assumed Flows" or "Suggested Discharges" is provided.
    - *Method:* "darcy"

    **TYPE 4: Physics-Based Simulation (L, D, f)**
    - *Goal:* Compute flows from scratch using physical pipe properties.
    - *Indicators:* Pipes defined by Length ($L$), Diameter ($D$), Friction ($f$). No initial flows given.
    - *Method:* "darcy"

    **Step 2: Extract Data**
    Return ONLY a JSON object with this EXACT schema:
    {
      "method": "puzzle" | "darcy",
      "problem_type": "TYPE_1" | "TYPE_2" | "TYPE_3" | "TYPE_4",
      "nodes": [{"id": "string", "demand": number | null, "source": "image_1" | "image_N" | "default"}], 
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
          "given_head_loss": number | null,
          "source": "image_1" | "image_N" | "default"
        }
      ]
    }
    Rules:
    - Connectivity: If schematic is text/table only (e.g. "Pipe AB"), infer Start=A, End=B.
    - Demand: Positive (+) for Inflow (Source), Negative (-) for Outflow (Sink).
    - Extract ALL visible data: If Type 2 problem shows Length/Diameter, extract them anyway.
    - TYPE 3: Extract suggested Q values into \`given_flow\`.
    - TYPE 4: Ensure L, D, f are extracted.
    - NO COMMENTS in JSON. NO MARKDOWN. Return raw JSON only.
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

			const result = await model.generateContent([prompt, ...imageParts]);

			let responseText = result.response.text();
			// Cleanup markdown and potential whitespace issues
			responseText = responseText
				.replace(/```json/g, "")
				.replace(/```/g, "")
				.trim();

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
