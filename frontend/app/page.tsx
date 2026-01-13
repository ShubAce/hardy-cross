"use client";
import { useState } from 'react';

export default function Home() {
  const [image, setImage] = useState<string | null>(null);
  const [networkData, setNetworkData] = useState<any>(null);
  const [solution, setSolution] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null); // New Error State
  const [step, setStep] = useState(1);

  // 1. Handle Image Upload & Vision
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setErrorMsg(null);
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result as string;
      setImage(base64);
      
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          body: JSON.stringify({ image: base64 }),
        });
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.error || "Vision Failed");

        setNetworkData(data);
        setStep(2);
      } catch (err: any) {
        setErrorMsg(err.message);
      }
      setLoading(false);
    };
    reader.readAsDataURL(file);
  };

  // 2. Handle Solve (Call Python)
  const handleSolve = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('http://localhost:8000/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(networkData),
      });
      
      const result = await res.json();

      // Check if backend returned an error (e.g., 500 Internal Server Error)
      if (!res.ok) {
        throw new Error(result.detail || "Solver failed on server.");
      }

      setSolution(result);
      setStep(3);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to connect to Python backend.");
    }
    setLoading(false);
  };

  return (
    <div className="p-10 max-w-4xl mx-auto font-sans min-h-screen bg-white text-gray-900">
      <h1 className="text-3xl font-bold mb-8 text-blue-700">Hardy Cross Solver AI</h1>

      {/* ERROR MESSAGE DISPLAY */}
      {errorMsg && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          <strong>Error: </strong> {errorMsg}
        </div>
      )}

      {/* STEP 1: UPLOAD */}
      {step === 1 && (
        <div className="border-2 border-dashed border-gray-300 p-12 text-center rounded-lg hover:bg-gray-50 transition">
          <p className="mb-4 text-gray-500">Upload an image of a pipe network</p>
          <input 
            type="file" 
            onChange={handleUpload} 
            accept="image/*" 
            className="block w-full text-sm text-slate-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-full file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100"
          />
          {loading && <p className="mt-4 text-blue-600 animate-pulse">Analyzing diagram with AI...</p>}
        </div>
      )}

      {/* STEP 2: VERIFY DATA */}
      {step === 2 && networkData && (
        <div>
          <h2 className="text-xl font-bold mb-4">Verify Extracted Data</h2>
          <p className="text-sm text-gray-500 mb-2">Check if the AI read your diagram correctly.</p>
          
          <div className="bg-slate-50 p-4 rounded mb-4 border overflow-auto max-h-96">
            <pre className="text-xs font-mono">{JSON.stringify(networkData, null, 2)}</pre>
          </div>
          
          <div className="flex gap-4">
            <button 
                onClick={handleSolve}
                className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
                disabled={loading}
            >
                {loading ? "Solving..." : "Run Hardy Cross Calculation"}
            </button>
            <button 
                onClick={() => setStep(1)}
                className="bg-gray-200 text-gray-700 px-6 py-2 rounded hover:bg-gray-300"
            >
                Cancel
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: RESULTS */}
      {step === 3 && solution && (
        <div>
          <h2 className="text-2xl font-bold mb-6 text-green-700">Calculation Complete</h2>
          
          <div className="mb-8 border rounded-lg overflow-hidden">
            <h3 className="bg-gray-100 p-3 font-bold border-b">Final Flow Rates</h3>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b text-sm text-gray-600 uppercase">
                  <th className="p-3">Pipe ID</th>
                  <th className="p-3">Flow (m³/s)</th>
                  <th className="p-3">Velocity (m/s)</th>
                  <th className="p-3">Head Loss (m)</th>
                </tr>
              </thead>
              <tbody>
                {/* SAFETY CHECK: Use ?. to prevent crash if results are missing */}
                {solution.results?.map((r: any) => (
                  <tr key={r.pipe_id} className="border-b hover:bg-gray-50">
                    <td className="p-3 font-mono font-bold">{r.pipe_id}</td>
                    <td className="p-3">{r.flow}</td>
                    <td className="p-3">{r.velocity}</td>
                    <td className="p-3">{r.head_loss}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="font-bold text-lg mb-2">Calculation History</h3>
            <div className="bg-slate-900 text-slate-100 p-4 rounded-lg h-64 overflow-y-scroll font-mono text-xs">
                {solution.history?.map((h: any) => (
                    <div key={h.iteration} className="mb-4 border-b border-slate-700 pb-2">
                        <p className="text-green-400 font-bold">Iteration {h.iteration}</p>
                        {h.loops.map((l: any, i: number) => (
                            <p key={i} className="ml-4">
                                Loop: [{l.nodes.join('-')}] | ΔQ: {l.delta_Q ? l.delta_Q.toFixed(6) : "0.000000"}
                            </p>
                        ))}
                    </div>
                ))}
            </div>
          </div>
          
          <button 
            onClick={() => setStep(1)} 
            className="mt-8 text-blue-600 underline hover:text-blue-800"
          >
            Solve Another Problem
          </button>
        </div>
      )}
    </div>
  );
}