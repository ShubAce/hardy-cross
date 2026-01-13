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
    Analyze this pipe network image. Return ONLY a JSON object with this EXACT schema:
    {
      "nodes": [{"id": "string", "demand": number}], 
      "pipes": [{"id": "string", "start_node": "string", "end_node": "string", "length": number, "diameter": number, "roughness": number, "resistance_k": number | null}]
    }
    Rules:
    - Demand: Positive (+) for Inflow (Source), Negative (-) for Outflow (Load).
    - length: Pipe length. If not visible in image, use 1 as default.
    - diameter: Pipe diameter. If not visible in image, use 1 as default.
    - roughness: Darcy friction factor 'f'. If unspecified, use 0.02.
    - resistance_k: If the image directly provides K, R, or resistance coefficient, use that value. Otherwise set to null.
      - Look for labels like "K=", "R=", "r=", "resistance=", or similar.
      - Common formats: K=500, R=1000, r=200 (units are s²/m⁵ typically)
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
