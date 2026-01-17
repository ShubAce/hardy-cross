"use client";
import { useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// Editable Cell Component (Styled for alignment)
const EditableCell = ({
	value,
	onChange,
	type = "number",
	placeholder = "",
}: {
	value: any;
	onChange: (val: any) => void;
	type?: string;
	placeholder?: string;
}) => {
	return (
		<input
			type={type}
			placeholder={placeholder}
			className="w-full bg-blue-50 border-b border-blue-200 focus:border-blue-600 outline-none px-2 py-1 text-right font-mono text-sm text-gray-800 transition placeholder:text-gray-400 placeholder:text-xs"
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
};

export default function Home() {
	const [images, setImages] = useState<string[]>([]);

	// State for Editable Data
	const [networkData, setNetworkData] = useState<any>(null); // To store method type
	const [nodes, setNodes] = useState<any[]>([]);
	const [pipes, setPipes] = useState<any[]>([]);
	const [fluid, setFluid] = useState({ density: 998, viscosity: 1.004e-6, temperature: 20 });

	const [solution, setSolution] = useState<any>(null);
	const [explanation, setExplanation] = useState<string>("");
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState("");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const [step, setStep] = useState(1);
	const [activeTab, setActiveTab] = useState<"geometry" | "boundary" | "initial" | "final" | "history">("geometry");
	const [showDiagrams, setShowDiagrams] = useState(false);
	const abortControllerRef = useRef<AbortController | null>(null);

	// Process image (shared between upload and camera)
	const processImages = async (base64Images: string[]) => {
		if (base64Images.length === 0) return;

		setLoading(true);
		setStatus(`Reading ${base64Images.length} diagram(s) (AI Vision)...`);
		setErrorMsg(null);

		try {
			const res = await fetch("/api/analyze", {
				method: "POST",
				body: JSON.stringify({ images: base64Images }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error);

			// Apply defaults for Type 2 per user requirements
			let finalPipes = data.pipes || [];
			if (data.problem_type === "TYPE_2") {
				finalPipes = finalPipes.map((p: any) => {
					// Defaults from user request: L=1, D=1, f=0.02
					const length = p.length ?? 1;
					const diameter = p.diameter ?? 1;
					const roughness = p.roughness ?? 0.02;

					let resistance_k = p.resistance_k;

					// If K/R is not given, calculate it using f (Darcy-Weisbach)
					// K = (8fL) / (π²gD⁵)
					if (resistance_k === null || resistance_k === undefined) {
						const g = 9.81;
						const num = 8 * roughness * length;
						const den = Math.PI * Math.PI * g * Math.pow(diameter, 5);
						resistance_k = num / den;
					}

					return { ...p, length, diameter, roughness, resistance_k };
				});
			}

			setNetworkData({ method: data.method, problem_type: data.problem_type });
			setNodes(data.nodes || []);
			setPipes(finalPipes);
			setStep(2);
		} catch (err: any) {
			setErrorMsg(err.message);
		}
		setLoading(false);
	};

	// Upload & Vision
	const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files || files.length === 0) return;

		const newImages: string[] = [];
		let processed = 0;

		Array.from(files).forEach((file) => {
			const reader = new FileReader();
			reader.onloadend = () => {
				const base64 = reader.result as string;
				newImages.push(base64);
				processed++;

				if (processed === files.length) {
					// All files read, update state
					setImages((prev) => [...prev, ...newImages]);
				}
			};
			reader.readAsDataURL(file);
		});
	};

	// Remove an image from the list
	const removeImage = (index: number) => {
		setImages((prev) => prev.filter((_, i) => i !== index));
	};

	// Trigger Analysis
	const handleAnalyze = () => {
		if (images.length === 0) {
			setErrorMsg("Please upload at least one image.");
			return;
		}
		processImages(images);
	};

	// Generate Initial Flows (Type 4)
	const generateInitialFlows = async () => {
		setLoading(true);
		setStatus("Calculating initial balanced flows...");
		try {
			const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
			const res = await fetch(`${API_URL}/initialize`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ method: "darcy", nodes, pipes, fluid }),
			});
			const flowData = await res.json();
			if (!res.ok) throw new Error(flowData.detail || "Initialization failed");

			// Update pipes with suggested flows
			const newPipes = pipes.map((p) => ({
				...p,
				given_flow: flowData[p.id] !== undefined ? flowData[p.id] : null,
			}));
			setPipes(newPipes);
			setStatus("Initial flows generated!");
			setActiveTab("initial"); // Switch to view result
		} catch (err: any) {
			setErrorMsg(err.message);
		}
		setLoading(false);
	};

	// 2. Solve & Stream
	const handleSolveAndExplain = async () => {
		// Cancel any pending operations from previous runs
		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
		}
		// Create new controller for this run
		const controller = new AbortController();
		abortControllerRef.current = controller;

		setLoading(true);
		setErrorMsg(null);
		setExplanation("");

		const payload = {
			method: networkData?.method || "darcy",
			nodes,
			pipes,
			fluid,
		};

		try {
			setStatus("Checking Physics & Solving...");
			const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
			const solveRes = await fetch(`${API_URL}/solve`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			const solveResult = await solveRes.json();
			if (!solveRes.ok) throw new Error(solveResult.detail || "Solver failed");

			setSolution(solveResult);
			setStep(3);
			setActiveTab("final"); // Default to final results in Step 3

			setStatus("Streaming Tutorial...");
			const response = await fetch("/api/explain", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ networkData: payload, solution: solveResult }),
				signal: controller.signal,
			});

			if (!response.ok || !response.body) throw new Error(response.statusText);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let done = false;

			while (!done) {
				const { value, done: doneReading } = await reader.read();
				done = doneReading;
				const chunkValue = decoder.decode(value, { stream: !done });
				setExplanation((prev) => prev + chunkValue);
			}
			setStatus("Complete");
		} catch (err: any) {
			if (err.name === "AbortError") {
				console.log("Operation aborted by user request.");
			} else {
				console.error(err);
				setErrorMsg(err.message || "Process failed.");
			}
		}
		setLoading(false);
	};

	// Handlers for Editing
	const updatePipe = (idx: number, field: string, val: string) => {
		const newPipes = [...pipes];
		// If updating 'start' or 'end' nodes, keep as string. Otherwise parse float.
		if (field === "start_node" || field === "end_node" || field === "id" || field === "source") {
			newPipes[idx][field] = val;
		} else if (field === "resistance_k" || field === "given_flow" || field === "given_head_loss") {
			// K and puzzle values can be empty/null
			newPipes[idx][field] = val === "" ? null : parseFloat(val);
			// Note: parseFloat("") is NaN, so check for empty string explicitly
		} else {
			newPipes[idx][field] = parseFloat(val) || 0;
		}
		setPipes(newPipes);
	};

	const updateNode = (idx: number, field: string, val: string) => {
		const newNodes = [...nodes];
		if (field === "id" || field === "source") {
			newNodes[idx][field] = val;
		} else {
			// Allow null/empty for puzzle mode
			newNodes[idx][field] = val === "" ? null : parseFloat(val);
		}
		setNodes(newNodes);
	};

	return (
		<div className="min-h-screen bg-gray-50 text-gray-900 font-sans pb-20">
			<div className="max-w-7xl mx-auto p-6">
				{/* HEADER */}
				<div className="flex justify-between items-center mb-8 border-b pb-4">
					<div>
						<h1 className="text-3xl font-bold text-blue-900">Hardy Cross Solver AI</h1>
						<p className="text-gray-500 text-sm">Automated Hydraulic Analysis</p>
					</div>
					{step > 1 && (
						<button
							onClick={() => {
								if (abortControllerRef.current) {
									abortControllerRef.current.abort();
								}
								setStep(1);
								setImages([]);
								setExplanation("");
								setNetworkData(null);
							}}
							className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300 text-sm text-gray-700 font-medium"
						>
							Reset
						</button>
					)}
				</div>

				{errorMsg && (
					<div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded shadow-sm">
						<p className="font-bold">Error</p> <p>{errorMsg}</p>
					</div>
				)}

				{/* STEP 1: UPLOAD */}
				{step === 1 && (
					<div className="max-w-xl mx-auto mt-10">
						<div className="border-4 border-dashed border-gray-300 rounded-2xl p-8 sm:p-16 text-center bg-white hover:border-blue-400 transition shadow-sm">
							<div className="text-6xl mb-4">📐</div>
							<h3 className="text-xl font-bold text-gray-700 mb-2">Upload Network Diagram</h3>
							<p className="text-gray-400 mb-6">Supports PNG, JPG schematics. Upload multiple images for a single problem.</p>
							<div className="flex flex-col gap-3 sm:flex-row sm:gap-4 justify-center items-center">
								{/* File picker - works on all devices */}
								<label className="w-full sm:w-auto bg-blue-600 text-white px-8 py-3 rounded-full font-bold shadow-lg hover:bg-blue-700 cursor-pointer inline-flex items-center justify-center gap-2 transition">
									<span>📁</span> Add Images
									<input
										type="file"
										onChange={handleUpload}
										accept="image/*"
										className="hidden"
										multiple
									/>
								</label>

								{/* Direct camera capture - opens native camera on mobile */}
								<label className="w-full sm:w-auto bg-green-600 text-white px-8 py-3 rounded-full font-bold shadow-lg hover:bg-green-700 cursor-pointer inline-flex items-center justify-center gap-2 transition">
									<span>📷</span> Take Photo
									<input
										type="file"
										onChange={handleUpload}
										accept="image/*"
										capture="environment"
										className="hidden"
									/>
								</label>
							</div>

							{/* Image Preview List */}
							{images.length > 0 && (
								<div className="mt-8 space-y-4">
									<h4 className="font-bold text-gray-700 border-b pb-2">Selected Images ({images.length})</h4>
									<div className="grid grid-cols-3 gap-4">
										{images.map((img, idx) => (
											<div
												key={idx}
												className="relative group"
											>
												<img
													src={img}
													className="w-full h-24 object-cover rounded border"
													alt={`Upload ${idx + 1}`}
												/>
												<button
													onClick={() => removeImage(idx)}
													className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 text-2xl flex items-center justify-center opacity-70 group-hover:opacity-100 transition shadow-md pb-1"
												>
													×
												</button>
											</div>
										))}
									</div>
									<button
										onClick={handleAnalyze}
										className="w-full bg-indigo-600 text-white font-bold py-3 rounded-xl shadow-lg hover:bg-indigo-700 transition animate-pulse"
									>
										Analyze Diagrams
									</button>
								</div>
							)}

							{loading && <p className="mt-6 text-blue-600 animate-pulse font-medium">{status}</p>}
						</div>
					</div>
				)}

				{/* STEP 2: EDIT & VERIFY DATA (STRICT MODE SWITCHING) */}
				{step === 2 && (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-8 animate-fade-in-up">
						{/* Left: Image (Common) */}
						<div className="bg-white p-4 rounded-xl shadow border h-fit">
							<h3 className="font-bold text-gray-400 mb-3 uppercase text-xs tracking-wider">Original Diagrams</h3>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								{images.map((img, idx) => (
									<div
										key={idx}
										className="relative"
									>
										<img
											src={img}
											alt={`Upload ${idx + 1}`}
											className="w-full rounded-lg border bg-gray-50 mb-2 cursor-pointer hover:scale-105 transition duration-300"
											onClick={() => window.open(img, "_blank")}
										/>
										<div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded backdrop-blur-sm">
											Img {idx + 1}
										</div>
									</div>
								))}
							</div>
							<div className="mt-4 p-3 bg-gray-50 rounded border text-xs text-gray-500">
								<strong>Detected Mode:</strong> {networkData?.problem_type || "Legacy/Default"}
								<p className="mt-1 opacity-70">
									{networkData?.problem_type === "TYPE_1" && "Puzzle Mode: Find missing values."}
									{networkData?.problem_type === "TYPE_2" && "Classic Hardy Cross: R/K given."}
									{networkData?.problem_type === "TYPE_3" && "Verification: Check suggested flows."}
									{(!networkData?.problem_type || networkData?.problem_type === "TYPE_4") && "Simulation: Full physics (L, D, f)."}
								</p>
							</div>
						</div>

						{/* Right: UI Switcher */}
						<div className="bg-white p-6 rounded-xl shadow border flex flex-col h-full">
							{/* --- TYPE 4 (Default): PHYSICS SIMULATION UI (Tabs) --- */}
							{(!networkData?.problem_type || networkData?.problem_type === "TYPE_4") && (
								<>
									<div className="flex justify-between items-center mb-4">
										<h2 className="text-xl font-bold text-blue-900">Network Configuration</h2>
										<div className="flex bg-gray-100 rounded-lg p-1">
											{(["geometry", "boundary", "initial"] as const).map((tab) => (
												<button
													key={tab}
													onClick={() => setActiveTab(tab)}
													className={`px-3 py-1 text-xs font-bold rounded-md transition ${
														activeTab === tab ? "bg-white text-blue-800 shadow-sm" : "text-gray-500 hover:text-gray-700"
													}`}
												>
													{tab === "geometry" && "1. Pipe Data"}
													{tab === "boundary" && "2. Boundary"}
													{tab === "initial" && "3. Init Flow"}
												</button>
											))}
										</div>
									</div>

									{activeTab === "geometry" && (
										<>
											<div className="mb-4 p-3 bg-blue-50/50 rounded-lg border border-blue-100">
												<h3 className="text-xs font-bold text-blue-900 uppercase mb-2">Fluid Properties</h3>
												<div className="grid grid-cols-3 gap-2">
													<div>
														<label className="text-[10px] font-semibold text-gray-500 block">Density ρ</label>
														<input
															type="number"
															value={fluid.density}
															onChange={(e) => setFluid({ ...fluid, density: parseFloat(e.target.value) || 0 })}
															className="w-full border rounded px-2 py-1 text-xs"
														/>
													</div>
													<div>
														<label className="text-[10px] font-semibold text-gray-500 block">Viscosity ν</label>
														<input
															type="text"
															value={fluid.viscosity}
															onChange={(e) => setFluid({ ...fluid, viscosity: parseFloat(e.target.value) || 0 })}
															className="w-full border rounded px-2 py-1 text-xs"
														/>
													</div>
													<div>
														<label className="text-[10px] font-semibold text-gray-500 block">Temp (°C)</label>
														<input
															type="number"
															value={fluid.temperature}
															onChange={(e) => setFluid({ ...fluid, temperature: parseFloat(e.target.value) || 0 })}
															className="w-full border rounded px-2 py-1 text-xs"
														/>
													</div>
												</div>
											</div>
											<div className="flex-grow flex flex-col">
												<h3 className="text-sm font-bold text-gray-700 uppercase mb-2">Pipe Geometry & Friction</h3>
												<div className="overflow-auto flex-grow mb-4 border rounded-lg shadow-sm bg-white">
													<table className="w-full text-sm text-left border-collapse">
														<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
															<tr>
																<th className="p-2 border-b">ID</th>
																<th className="p-2 border-b text-center">Start</th>
																<th className="p-2 border-b text-center">End</th>
																<th className="p-2 border-b text-right bg-blue-50 text-blue-800">Length (m)</th>
																<th className="p-2 border-b text-right">Diam (m)</th>
																<th className="p-2 border-b text-right bg-orange-50 text-orange-800">f (friction)</th>
															</tr>
														</thead>
														<tbody className="bg-white">
															{pipes.map((p, i) => (
																<tr
																	key={i}
																	className="border-b hover:bg-gray-50"
																>
																	<td className="p-2 font-bold text-gray-700">
																		<EditableCell
																			value={p.id}
																			onChange={(v) => updatePipe(i, "id", v)}
																			type="text"
																		/>
																	</td>
																	<td className="p-2 text-center">{p.start_node}</td>
																	<td className="p-2 text-center">{p.end_node}</td>
																	<td className="p-2 bg-blue-50/30">
																		<EditableCell
																			value={p.length}
																			onChange={(v) => updatePipe(i, "length", v)}
																		/>
																	</td>
																	<td className="p-2">
																		<EditableCell
																			value={p.diameter}
																			onChange={(v) => updatePipe(i, "diameter", v)}
																		/>
																	</td>
																	<td className="p-2 bg-orange-50/10">
																		<EditableCell
																			value={p.roughness}
																			onChange={(v) => updatePipe(i, "roughness", v)}
																		/>
																	</td>
																</tr>
															))}
														</tbody>
													</table>
												</div>
											</div>
										</>
									)}

									{activeTab === "boundary" && (
										<div className="flex-grow flex flex-col">
											<div className="flex justify-between items-center mb-2">
												<h3 className="text-sm font-bold text-gray-700 uppercase">Node Boundary Conditions</h3>
												<span className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
													Σ Flow = {nodes.reduce((acc, n) => acc + (n.demand || 0), 0).toFixed(2)} (Should be 0)
												</span>
											</div>
											<div className="overflow-auto flex-grow mb-4 border rounded-lg shadow-sm bg-white">
												<table className="w-full text-sm text-left border-collapse">
													<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
														<tr>
															<th className="p-3 border-b">Node ID</th>
															<th className="p-3 border-b">Type</th>
															<th className="p-3 border-b text-right">External Flow (m³/s)</th>
														</tr>
													</thead>
													<tbody className="bg-white">
														{nodes.map((n, i) => {
															const demand = n.demand || 0;
															let type = "Internal";
															if (demand > 0) type = "Inflow (Source)";
															if (demand < 0) type = "Outflow (Sink)";

															return (
																<tr
																	key={i}
																	className="border-b hover:bg-gray-50"
																>
																	<td className="p-3 font-bold text-gray-700">{n.id}</td>
																	<td className="p-3">
																		<span
																			className={`text-xs px-2 py-1 rounded-full ${
																				type.includes("Inflow")
																					? "bg-green-100 text-green-800"
																					: type.includes("Outflow")
																					? "bg-red-100 text-red-800"
																					: "bg-gray-100 text-gray-600"
																			}`}
																		>
																			{type}
																		</span>
																	</td>
																	<td className="p-3">
																		<EditableCell
																			value={n.demand ?? ""}
																			placeholder="0"
																			onChange={(v) => updateNode(i, "demand", v)}
																		/>
																	</td>
																</tr>
															);
														})}
													</tbody>
												</table>
											</div>
										</div>
									)}

									{activeTab === "initial" && (
										<div className="flex-grow flex flex-col">
											<div className="flex justify-between items-center mb-2">
												<h3 className="text-sm font-bold text-gray-700 uppercase">Initial Flow Estimates</h3>
												<button
													onClick={generateInitialFlows}
													className="text-xs bg-indigo-50 text-indigo-700 px-3 py-1 rounded hover:bg-indigo-100 border border-indigo-200 transition"
												>
													Auto-Generate Balanced Flows
												</button>
											</div>
											<div className="overflow-auto flex-grow mb-4 border rounded-lg shadow-sm bg-white">
												<table className="w-full text-sm text-left border-collapse">
													<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
														<tr>
															<th className="p-3 border-b">Pipe ID</th>
															<th className="p-3 border-b text-center">Direction</th>
															<th className="p-3 border-b text-right">Initial Q (m³/s)</th>
														</tr>
													</thead>
													<tbody className="bg-white">
														{pipes.map((p, i) => {
															const flow = p.given_flow || 0;
															const flowDir =
																flow >= 0 ? `${p.start_node} → ${p.end_node}` : `${p.end_node} → ${p.start_node}`;

															return (
																<tr
																	key={i}
																	className="border-b hover:bg-gray-50"
																>
																	<td className="p-3 font-bold text-gray-700">{p.id}</td>
																	<td className="p-3 text-center text-xs text-gray-500">{flowDir}</td>
																	<td className="p-3 bg-green-50/20">
																		<EditableCell
																			value={p.given_flow ?? ""}
																			placeholder="0"
																			onChange={(v) => updatePipe(i, "given_flow", v)}
																		/>
																	</td>
																</tr>
															);
														})}
													</tbody>
												</table>
											</div>
											<p className="text-xs text-gray-400 italic mt-2">
												* These are starting guesses. Hardy Cross will iteratively correct them.
											</p>
										</div>
									)}
								</>
							)}

							{/* --- TYPE 2 (Classic) & TYPE 3 (Verification) --- */}
							{(networkData?.problem_type === "TYPE_2" || networkData?.problem_type === "TYPE_3") && (
								<div className="flex-grow flex flex-col">
									<h2 className="text-xl font-bold text-blue-900 mb-2">
										{networkData?.problem_type === "TYPE_3" ? "Verify Suggested Flows" : "Hardy Cross Data"}
									</h2>

									{/* Pipes Table */}
									<h3 className="text-sm font-bold text-gray-700 uppercase mb-2">Pipe Data (All Fields)</h3>
									<div
										className="overflow-auto grow mb-4 border rounded-lg shadow-sm bg-white"
										style={{ minHeight: "200px" }}
									>
										<table className="w-full text-sm text-left border-collapse">
											<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
												<tr>
													<th className="p-2 border-b">ID</th>
													<th className="p-2 border-b text-center">Start</th>
													<th className="p-2 border-b text-center">End</th>
													<th className="p-2 border-b text-right">L (m)</th>
													<th className="p-2 border-b text-right">D (m)</th>
													<th className="p-2 border-b text-right">f</th>
													<th className="p-2 border-b text-right bg-purple-50 text-purple-800">K/r</th>
												</tr>
											</thead>
											<tbody className="bg-white">
												{pipes.map((p, i) => (
													<tr
														key={i}
														className="border-b hover:bg-gray-50"
													>
														<td className="p-2 font-bold text-gray-700">{p.id}</td>
														<td className="p-2 text-center text-xs">{p.start_node}</td>
														<td className="p-2 text-center text-xs">{p.end_node}</td>
														<td className="p-2">
															<EditableCell
																value={p.length}
																onChange={(v) => updatePipe(i, "length", v)}
															/>
														</td>
														<td className="p-2">
															<EditableCell
																value={p.diameter}
																onChange={(v) => updatePipe(i, "diameter", v)}
															/>
														</td>
														<td className="p-2">
															<EditableCell
																value={p.roughness}
																onChange={(v) => updatePipe(i, "roughness", v)}
															/>
														</td>
														<td className="p-2 bg-purple-50/20">
															<EditableCell
																value={p.resistance_k}
																onChange={(v) => updatePipe(i, "resistance_k", v)}
															/>
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>

									{/* Nodes Table */}
									<div className="flex justify-between items-center mb-2 mt-4">
										<h3 className="text-sm font-bold text-gray-700 uppercase">Node Demands</h3>
										<span className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
											Σ Flow = {nodes.reduce((acc, n) => acc + (n.demand || 0), 0).toFixed(2)}
										</span>
									</div>
									<div
										className="overflow-auto grow mb-4 border rounded-lg shadow-sm bg-white"
										style={{ minHeight: "150px" }}
									>
										<table className="w-full text-sm text-left border-collapse">
											<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
												<tr>
													<th className="p-3 border-b">Node ID</th>
													<th className="p-3 border-b">Status</th>
													<th className="p-3 border-b text-right">Demand (m³/s)</th>
												</tr>
											</thead>
											<tbody className="bg-white">
												{nodes.map((n, i) => {
													const demand = n.demand || 0;
													let type = "Internal";
													let typeClass = "bg-gray-100 text-gray-600";
													if (demand > 0) {
														type = "Inflow (+)";
														typeClass = "bg-green-100 text-green-800";
													}
													if (demand < 0) {
														type = "Outflow (-)";
														typeClass = "bg-red-100 text-red-800";
													}

													return (
														<tr
															key={i}
															className="border-b hover:bg-gray-50"
														>
															<td className="p-3 font-bold text-gray-700">{n.id}</td>
															<td className="p-3">
																<span className={`text-xs px-2 py-1 rounded-full ${typeClass}`}>{type}</span>
															</td>
															<td className="p-3">
																<EditableCell
																	value={n.demand ?? ""}
																	placeholder="0"
																	onChange={(v) => updateNode(i, "demand", v)}
																/>
															</td>
														</tr>
													);
												})}
											</tbody>
										</table>
									</div>
								</div>
							)}

							{/* --- TYPE 1: PUZZLE MODE --- */}
							{networkData?.problem_type === "TYPE_1" && (
								<div className="flex-grow flex flex-col">
									<h2 className="text-xl font-bold text-blue-900 mb-4">Identify Missing Values</h2>
									<div className="overflow-auto flex-grow mb-4 border rounded-lg shadow-sm bg-white">
										<table className="w-full text-sm text-left border-collapse">
											<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
												<tr>
													<th className="p-3 border-b">Pipe (Nodes)</th>
													<th className="p-3 border-b text-right">Flow Q (m³/s)</th>
													<th className="p-3 border-b text-right">Head Loss (m)</th>
												</tr>
											</thead>
											<tbody className="bg-white">
												{pipes.map((p, i) => (
													<tr
														key={i}
														className="border-b hover:bg-gray-50"
													>
														<td className="p-3 font-bold text-gray-700">
															{p.id}{" "}
															<span className="text-xs text-gray-400">
																({p.start_node}-{p.end_node})
															</span>
														</td>
														<td className="p-3 bg-blue-50/20">
															<EditableCell
																value={p.given_flow ?? ""}
																placeholder="?"
																onChange={(v) => updatePipe(i, "given_flow", v)}
															/>
														</td>
														<td className="p-3 bg-orange-50/20">
															<EditableCell
																value={p.given_head_loss ?? ""}
																placeholder="?"
																onChange={(v) => updatePipe(i, "given_head_loss", v)}
															/>
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</div>
							)}

							<button
								onClick={handleSolveAndExplain}
								disabled={loading}
								className="mt-auto w-full bg-blue-600 text-white text-lg font-bold py-4 rounded-xl shadow-lg hover:bg-blue-700 transition disabled:opacity-70 disabled:cursor-not-allowed"
							>
								{loading ? (
									<span className="flex items-center justify-center gap-2">
										<span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
										{status}
									</span>
								) : (
									"Start Hardy Cross Solution →"
								)}
							</button>
						</div>
					</div>
				)}

				{/* STEP 3: RESULTS */}
				{step === 3 && solution && (
					<div className="space-y-8 animate-fade-in-up">
						{/* Top Row: Split View */}
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
							{/* Image */}
							<div className="bg-white p-4 rounded-xl shadow-lg border">
								<div
									className="flex justify-between items-center mb-2 cursor-pointer lg:cursor-default p-2 lg:p-0 hover:bg-gray-50 lg:hover:bg-white rounded transition"
									onClick={() => setShowDiagrams(!showDiagrams)}
								>
									<h3 className="font-bold text-gray-400 uppercase text-xs tracking-wider">Reference Diagrams</h3>
									<span className="text-blue-500 text-xs font-bold lg:hidden flex items-center gap-1">
										{showDiagrams ? (
											<>
												Hide <span>▲</span>
											</>
										) : (
											<>
												Show <span>▼</span>
											</>
										)}
									</span>
								</div>
								<div
									className={`transition-all duration-300 ease-in-out gap-2 p-2 bg-gray-50 rounded-lg ${
										showDiagrams ? "grid grid-cols-1 sm:grid-cols-2 h-96 overflow-y-auto" : "hidden"
									} lg:grid lg:grid-cols-2 lg:h-96 lg:overflow-y-auto`}
								>
									{images.map((img, idx) => (
										<img
											key={idx}
											src={img}
											alt="Network"
											className="w-full h-auto object-contain border rounded shadow-sm hover:scale-105 transition"
											onClick={() => window.open(img, "_blank")}
										/>
									))}
								</div>
							</div>

							{/* Final Answer Table */}
							<div className="bg-white p-6 rounded-xl shadow-lg border flex flex-col">
								<h3 className="text-xl font-bold text-green-700 mb-2 flex items-center gap-2">✅ Final Calculation Results</h3>
								<p className="text-sm text-gray-500 mb-2">
									{solution.converged
										? `Converged in ${solution.iterations} iteration(s)`
										: `⚠️ Did not converge after ${solution.iterations} iterations`}
								</p>
								<div className="text-xs mb-4 p-2 bg-blue-50 rounded border border-blue-200">
									<strong>📌 Sign Convention:</strong> <span className="text-blue-700">+Q</span> = flow from{" "}
									<strong>Start→End</strong> node | <span className="text-orange-700">−Q</span> = flow from{" "}
									<strong>End→Start</strong> node
								</div>
								<div className="overflow-x-auto flex-grow">
									<table className="w-full text-left text-sm border-collapse">
										<thead>
											<tr className="bg-green-50 text-green-900 text-xs uppercase tracking-wider border-b-2 border-green-200">
												<th className="p-3">Pipe</th>
												<th className="p-3 text-center">Start Node</th>
												<th className="p-3 text-center">End Node</th>
												{networkData?.method !== "puzzle" && (
													<th className="p-3 text-right bg-purple-50 text-purple-800">K (s²/m⁵)</th>
												)}
												<th className="p-3 text-right">Flow Q (m³/s)</th>
												{networkData?.method !== "puzzle" && <th className="p-3 text-right">Velocity</th>}
												<th className="p-3 text-right">Head Loss</th>
											</tr>
										</thead>
										<tbody className="text-gray-700">
											{solution.results?.map((r: any, idx: number) => (
												<tr
													key={r.pipe_id}
													className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}
												>
													<td className="p-3 font-bold border-b">{r.pipe_id}</td>
													<td className="p-3 text-center border-b">{r.start_node}</td>
													<td className="p-3 text-center border-b">{r.end_node}</td>
													{networkData?.method !== "puzzle" && (
														<td className="p-3 text-right font-mono border-b bg-purple-50/30">
															<span className="font-medium">{r.K}</span>
															<span className="text-xs text-gray-400 ml-1">
																({r.K_source === "provided" ? "given" : "calc"})
															</span>
														</td>
													)}
													<td
														className={`p-3 text-right font-mono font-medium border-b ${
															r.flow >= 0 ? "text-blue-700" : "text-orange-700"
														}`}
													>
														{r.flow >= 0 ? "+" : ""}
														{Number(r.flow).toFixed(5)}
													</td>
													{networkData?.method !== "puzzle" && (
														<td className="p-3 text-right border-b">{r.velocity} m/s</td>
													)}
													<td className="p-3 text-right border-b">{Number(r.head_loss).toFixed(5)} m</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>

								{/* Node Results (Puzzle Only) */}
								{networkData?.method === "puzzle" && solution.node_results && (
									<div className="mt-6 border-t pt-6">
										<h3 className="text-lg font-bold text-blue-800 mb-3 block">Solved Node Demands</h3>
										<div className="overflow-x-auto border rounded-lg">
											<table className="w-full text-left text-sm border-collapse">
												<thead>
													<tr className="bg-blue-50 text-blue-900 text-xs uppercase tracking-wider border-b-2 border-blue-200">
														<th className="p-3">Node</th>
														<th className="p-3 text-right">Net Discharge (m³/s)</th>
														<th className="p-3 text-right">Status</th>
													</tr>
												</thead>
												<tbody className="text-gray-700">
													{solution.node_results.map((n: any) => (
														<tr
															key={n.node_id}
															className="border-b bg-white"
														>
															<td className="p-3 font-bold">{n.node_id}</td>
															<td className="p-3 text-right font-mono text-blue-700 font-bold">
																{n.demand !== null ? Number(n.demand).toFixed(2) : "?"}
															</td>
															<td className="p-3 text-right">
																{n.is_solved ? (
																	<span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full font-bold">
																		FOUND
																	</span>
																) : (
																	<span className="text-xs text-gray-400">Given</span>
																)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</div>
								)}
							</div>
						</div>

						{/* Bottom Row: AI Explanation */}
						<div className="bg-white p-8 rounded-xl shadow-lg border min-h-[300px]">
							<h2 className="text-2xl font-bold text-gray-800 mb-6 flex justify-between border-b pb-4">
								<span>📘 Detailed Step-by-Step Solution</span>
								{loading && <span className="text-sm font-normal text-blue-600 animate-pulse">AI is writing...</span>}
							</h2>
							<div className="solution-content">
								<ReactMarkdown
									remarkPlugins={[remarkGfm, remarkMath]}
									rehypePlugins={[rehypeKatex]}
									components={{
										h2: ({ children }) => (
											<h2 className="text-xl font-bold text-blue-800 mt-8 mb-4 pb-2 border-b-2 border-blue-200 flex items-center gap-2">
												{children}
											</h2>
										),
										h3: ({ children }) => <h3 className="text-lg font-semibold text-gray-700 mt-6 mb-3">{children}</h3>,
										p: ({ children }) => <p className="text-gray-600 leading-relaxed mb-4">{children}</p>,
										ul: ({ children }) => <ul className="list-disc list-inside mb-4 space-y-1 text-gray-600">{children}</ul>,
										ol: ({ children }) => <ol className="list-decimal list-inside mb-4 space-y-1 text-gray-600">{children}</ol>,
										li: ({ children }) => <li className="ml-4">{children}</li>,
										strong: ({ children }) => <strong className="font-semibold text-gray-800">{children}</strong>,
										table: ({ children }) => (
											<div className="overflow-x-auto my-6 rounded-lg border border-gray-200 shadow-sm">
												<table className="w-full text-sm border-collapse">{children}</table>
											</div>
										),
										thead: ({ children }) => <thead className="bg-gradient-to-r from-blue-50 to-blue-100">{children}</thead>,
										tbody: ({ children }) => <tbody className="divide-y divide-gray-100">{children}</tbody>,
										tr: ({ children }) => <tr className="hover:bg-gray-50 transition-colors">{children}</tr>,
										th: ({ children }) => (
											<th className="px-4 py-3 text-left font-semibold text-blue-900 text-xs uppercase tracking-wider border-b-2 border-blue-200">
												{children}
											</th>
										),
										td: ({ children }) => <td className="px-4 py-3 text-gray-700 font-mono text-sm">{children}</td>,
										code: ({ children, className }) => {
											const isInline = !className;
											return isInline ? (
												<code className="bg-blue-50 text-blue-800 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
											) : (
												<code className="block bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm font-mono my-4">
													{children}
												</code>
											);
										},
										blockquote: ({ children }) => (
											<blockquote className="border-l-4 border-blue-400 bg-blue-50 pl-4 py-2 my-4 italic text-gray-600">
												{children}
											</blockquote>
										),
									}}
								>
									{explanation}
								</ReactMarkdown>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
