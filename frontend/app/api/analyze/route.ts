// app/api/analyze/route.ts
import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: Request) {
	// 1. Validate API Key
	const apiKey = process.env.GOOGLE_API_KEY;
	if (!apiKey) {
		return NextResponse.json({ error: "Missing GOOGLE_API_KEY in .env.local" }, { status: 500 });
	}

	try {
		const genAI = new GoogleGenerativeAI(apiKey);
		// Use 'gemini-1.5-pro' for best extraction of engineering diagrams
		const model = genAI.getGenerativeModel({
			model: "gemini-2.5-flash",
			generationConfig: { responseMimeType: "application/json" },
		});

		const { image } = await request.json(); // Expects full base64 string (data:image/png;base64,...)

		if (!image) {
			return NextResponse.json({ error: "No image provided" }, { status: 400 });
		}

		// 2. Prepare Image for Gemini
		// The frontend sends "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA..."
		// Gemini needs TWO parts:
		//   a) The mime type (image/png)
		//   b) The raw base64 data (iVBORw0KGgo...)

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
    - roughness: Darcy friction factor 'f'. If unspecified, use 0.02.
    - resistance_k: If the image directly provides K, R, or resistance coefficient, use that value. Otherwise set to null.
      - Look for labels like "K=", "R=", "r=", "resistance=", or similar.
      - Common formats: K=500, R=1000, r=200 (units are s²/m⁵ typically)
    - Units: Assume SI (meters) unless marked otherwise.
    - If you see both f (friction factor) AND K (resistance), include both values.
    `;

		console.log(" Sending to Gemini 2.5 flash...");

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
		console.log("✅ Gemini Response:", responseText.substring(0, 100) + "...");

		const data = JSON.parse(responseText);
		return NextResponse.json(data);
	} catch (error: any) {
		console.error("❌ Gemini Vision Error:", error);
		return NextResponse.json({ error: error.message || "Vision Failed" }, { status: 500 });
	}
}
