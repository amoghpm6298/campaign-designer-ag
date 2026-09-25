// Phase 0 placeholder — proves the build/deploy pipeline (Vite build,
// subpath base, Vercel preview) works before any real feature code lands.
// Replaced in Phase 1+ with the real Drip Campaigns app.
function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 40 }}>
      <h1>Drip Campaigns — pipeline spike</h1>
      <p>
        If you can see this at <code>/drip-campaigns/</code> with no console
        errors and no broken asset requests, the build/deploy pipeline is
        proven and Phase 1 can start.
      </p>
    </div>
  )
}

export default App
