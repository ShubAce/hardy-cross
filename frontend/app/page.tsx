"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
};

export default function Home() {
	const [image, setImage] = useState<string | null>(null);

	// State for Editable Data
	const [nodes, setNodes] = useState<any[]>([]);
	const [pipes, setPipes] = useState<any[]>([]);

	const [solution, setSolution] = useState<any>(null);
	const [explanation, setExplanation] = useState<string>("");
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState("");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const [step, setStep] = useState(1);

	// Process image (shared between upload and camera)
	const processImage = async (base64: string) => {
		setLoading(true);
		setStatus("Reading diagram (AI Vision)...");
		setErrorMsg(null);
		setImage(base64);

		try {
			const res = await fetch("/api/analyze", {
				method: "POST",
				body: JSON.stringify({ image: base64 }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error);

			setNodes(data.nodes || []);
			setPipes(data.pipes || []);
			setStep(2);
		} catch (err: any) {
			setErrorMsg(err.message);
		}
		setLoading(false);
	};

	// Upload & Vision
	const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onloadend = async () => {
			const base64 = reader.result as string;
			await processImage(base64);
		};
		reader.readAsDataURL(file);
	};

	// 2. Solve & Stream
	const handleSolveAndExplain = async () => {
		setLoading(true);
		setErrorMsg(null);
		setExplanation("");

		const payload = { nodes, pipes };

		try {
			setStatus("Checking Physics & Solving...");
			const solveRes = await fetch("http://localhost:8000/solve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const solveResult = await solveRes.json();
			if (!solveRes.ok) throw new Error(solveResult.detail || "Solver failed");

			setSolution(solveResult);
			setStep(3);

			setStatus("Streaming Tutorial...");
			const response = await fetch("/api/explain", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ networkData: payload, solution: solveResult }),
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
			console.error(err);
			setErrorMsg(err.message || "Process failed.");
		}
		setLoading(false);
	};

	// Handlers for Editing
	const updatePipe = (idx: number, field: string, val: string) => {
		const newPipes = [...pipes];
		// If updating 'start' or 'end' nodes, keep as string. Otherwise parse float.
		if (field === "start_node" || field === "end_node" || field === "id") {
			newPipes[idx][field] = val;
		} else if (field === "resistance_k") {
			// K can be empty (will be calculated) or a number
			newPipes[idx][field] = val === "" ? null : parseFloat(val) || null;
		} else {
			newPipes[idx][field] = parseFloat(val) || 0;
		}
		setPipes(newPipes);
	};

	const updateNode = (idx: number, field: string, val: string) => {
		const newNodes = [...nodes];
		newNodes[idx][field] = field === "id" ? val : parseFloat(val) || 0;
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
								setStep(1);
								setImage(null);
								setExplanation("");
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
							<p className="text-gray-400 mb-6">Supports PNG, JPG schematics</p>
							<div className="flex flex-col gap-3 sm:flex-row sm:gap-4 justify-center items-center">
								{/* File picker - works on all devices */}
								<label className="w-full sm:w-auto bg-blue-600 text-white px-8 py-3 rounded-full font-bold shadow-lg hover:bg-blue-700 cursor-pointer inline-flex items-center justify-center gap-2 transition">
									<span>📁</span> Select Image
									<input
										type="file"
										onChange={handleUpload}
										accept="image/*"
										className="hidden"
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
							{loading && <p className="mt-6 text-blue-600 animate-pulse font-medium">{status}</p>}
						</div>
					</div>
				)}

				{/* STEP 2: EDIT & VERIFY DATA (FIXED LAYOUT) */}
				{step === 2 && (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-8 animate-fade-in-up">
						{/* Left: Image */}
						<div className="bg-white p-4 rounded-xl shadow border h-fit">
							<h3 className="font-bold text-gray-400 mb-3 uppercase text-xs tracking-wider">Original Diagram</h3>
							{image && (
								<img
									src={image}
									alt="Upload"
									className="w-full rounded-lg border bg-gray-50"
								/>
							)}
						</div>

						{/* Right: Editable Tables */}
						<div className="bg-white p-6 rounded-xl shadow border flex flex-col h-full">
							<h2 className="text-xl font-bold mb-2 text-blue-900">Verify & Edit Data</h2>
							<p className="text-sm text-gray-500 mb-6 bg-yellow-50 p-2 rounded border border-yellow-200">
								<span className="font-bold">💡 Tip:</span> Check values carefully. Positive flow follows the{" "}
								<strong>Start → End</strong> direction shown below.
							</p>

							{/* PIPES TABLE - FIXED HEADERS & WIDTHS */}
							<h3 className="text-sm font-bold text-gray-700 uppercase mb-2 flex items-center gap-2">
								<span>Pipe Properties</span>
								<span className="text-xs font-normal text-gray-400 normal-case">(K auto-calculated from f if not provided)</span>
							</h3>
							<div className="overflow-auto max-h-80 mb-8 border rounded-lg shadow-sm bg-white">
								<table className="w-full text-sm text-left border-collapse">
									<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
										<tr>
											<th className="p-3 border-b">ID</th>
											<th className="p-3 border-b text-center">Start</th>
											<th className="p-3 border-b text-center">End</th>
											<th className="p-3 border-b text-right bg-blue-50 text-blue-800">Length (m)</th>
											<th className="p-3 border-b text-right">Diam (m)</th>
											<th className="p-3 border-b text-right bg-orange-50 text-orange-800">f (friction)</th>
											<th className="p-3 border-b text-right bg-purple-50 text-purple-800">K or R</th>
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
												<td className="p-2">
													<EditableCell
														value={p.start_node}
														onChange={(v) => updatePipe(i, "start_node", v)}
														type="text"
													/>
												</td>
												<td className="p-2">
													<EditableCell
														value={p.end_node}
														onChange={(v) => updatePipe(i, "end_node", v)}
														type="text"
													/>
												</td>

												{/* Length Column (Blue Tint) */}
												<td className="p-2 bg-blue-50/30">
													<EditableCell
														value={p.length}
														onChange={(v) => updatePipe(i, "length", v)}
													/>
												</td>

												{/* Diameter Column */}
												<td className="p-2">
													<EditableCell
														value={p.diameter}
														onChange={(v) => updatePipe(i, "diameter", v)}
													/>
												</td>

												{/* Roughness Column (Orange Tint) */}
												<td className="p-2 bg-orange-50/30">
													<EditableCell
														value={p.roughness}
														onChange={(v) => updatePipe(i, "roughness", v)}
														placeholder="0.02"
													/>
												</td>

												{/* K/R Column (Purple Tint) - Direct resistance coefficient */}
												<td className="p-2 bg-purple-50/30">
													<EditableCell
														value={p.resistance_k ?? ""}
														onChange={(v) => updatePipe(i, "resistance_k", v)}
														placeholder="auto"
													/>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<p className="text-xs text-gray-500 mb-4 bg-purple-50 p-2 rounded border border-purple-200">
								<strong>💡 K/R:</strong> If given directly in the image, enter it. Otherwise leave as "auto" and it will be calculated
								from: K = 8fL / (π²gD⁵)
							</p>

							{/* NODES TABLE */}
							<h3 className="text-sm font-bold text-gray-700 uppercase mb-2">Node Demands</h3>
							<div className="overflow-auto max-h-60 mb-6 border rounded-lg shadow-sm">
								<table className="w-full text-sm text-left border-collapse">
									<thead className="bg-gray-100 text-gray-600 uppercase text-xs sticky top-0 z-10">
										<tr>
											<th className="p-3 border-b">Node ID</th>
											<th className="p-3 border-b text-right">Demand (m³/s)</th>
										</tr>
									</thead>
									<tbody className="bg-white">
										{nodes.map((n, i) => (
											<tr
												key={i}
												className="border-b hover:bg-gray-50"
											>
												<td className="p-3 font-bold text-gray-700">{n.id}</td>
												<td className="p-3">
													<div className="flex items-center justify-end gap-2">
														<span className="text-xs text-gray-400">
															{n.demand > 0 ? "(Inflow +)" : n.demand < 0 ? "(Outflow -)" : ""}
														</span>
														<div className="w-24">
															<EditableCell
																value={n.demand}
																onChange={(v) => updateNode(i, "demand", v)}
															/>
														</div>
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>

							<button
								onClick={handleSolveAndExplain}
								disabled={loading}
								className="w-full bg-blue-600 text-white text-lg font-bold py-4 rounded-xl shadow-lg hover:bg-blue-700 transition disabled:opacity-70 disabled:cursor-not-allowed"
							>
								{loading ? (
									<span className="flex items-center justify-center gap-2">
										<span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
										{status}
									</span>
								) : (
									"Confirm Data & Solve →"
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
								<h3 className="font-bold text-gray-400 mb-2 uppercase text-xs tracking-wider">Reference Diagram</h3>
								<div className="flex items-center justify-center bg-gray-100 rounded-lg h-[400px] overflow-hidden">
									{image && (
										<img
											src={image}
											alt="Network"
											className="max-w-full max-h-full object-contain"
										/>
									)}
								</div>
							</div>

							{/* Final Answer Table */}
							<div className="bg-white p-6 rounded-xl shadow-lg border flex flex-col">
								<h3 className="text-xl font-bold text-green-700 mb-2 flex items-center gap-2">✅ Final Calculation Results</h3>
								<p className="text-sm text-gray-500 mb-4">
									{solution.converged
										? `Converged in ${solution.iterations} iteration(s)`
										: `⚠️ Did not converge after ${solution.iterations} iterations`}
								</p>
								<div className="overflow-x-auto flex-grow">
									<table className="w-full text-left text-sm border-collapse">
										<thead>
											<tr className="bg-green-50 text-green-900 text-xs uppercase tracking-wider border-b-2 border-green-200">
												<th className="p-3">Pipe</th>
												<th className="p-3 text-right bg-purple-50 text-purple-800">K (s²/m⁵)</th>
												<th className="p-3 text-right">Flow (Q)</th>
												<th className="p-3 text-center">Dir</th>
												<th className="p-3 text-right">Velocity</th>
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
													<td className="p-3 text-right font-mono border-b bg-purple-50/30">
														<span className="font-medium">{r.K}</span>
														<span className="text-xs text-gray-400 ml-1">
															({r.K_source === "provided" ? "given" : "calc"})
														</span>
													</td>
													<td className="p-3 text-right font-mono font-medium border-b">
														{Math.abs(r.flow).toFixed(5)} m³/s
													</td>
													<td className="p-3 text-center border-b">
														<span
															className={`px-2 py-1 rounded text-xs font-medium ${
																r.flow >= 0 ? "bg-blue-100 text-blue-800" : "bg-orange-100 text-orange-800"
															}`}
														>
															{r.flow >= 0 ? "→" : "←"}
														</span>
													</td>
													<td className="p-3 text-right border-b">{r.velocity} m/s</td>
													<td className="p-3 text-right border-b">{r.head_loss} m</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
						</div>

						{/* Bottom Row: AI Explanation */}
						<div className="bg-white p-8 rounded-xl shadow-lg border min-h-[300px]">
							<h2 className="text-2xl font-bold text-gray-800 mb-6 flex justify-between border-b pb-4">
								<span>Detailed Solution</span>
								{loading && <span className="text-sm font-normal text-blue-600 animate-pulse">AI is writing...</span>}
							</h2>
							<div className="prose prose-slate max-w-none prose-headings:text-blue-800 prose-table:border prose-th:bg-gray-100 prose-th:p-3 prose-td:p-3">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>{explanation}</ReactMarkdown>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
