import { ServiceHealth } from './components/ServiceHealth.js';
import './styles.css';

export default function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CentrAlign Operator home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>CentrAlign <b>Operator</b></span></a>
        <span className="environment-label">LOCAL DEVELOPMENT</span>
      </header>
      <main>
        <div className="intro">
          <span className="phase-badge"><span aria-hidden="true">03</span> Autonomous backend runtime</span>
          <h1>Verified work starts<br />with a reliable foundation.</h1>
          <p className="description">An autonomous enterprise operator designed to complete verified business work.</p>
        </div>
        <div className="dashboard-grid">
          <ServiceHealth />
          <section className="scope-card" aria-labelledby="scope-title">
            <p className="eyebrow">CURRENT DEVELOPMENT PHASE</p>
            <h2 id="scope-title">Phase 3 / 5</h2>
            <p>Autonomous backend execution with verified outcomes.</p>
            <ul className="foundation-list">
              <li><span aria-hidden="true">01</span><div><strong>Company context</strong><p>Indexed fictional sources with traceable excerpts.</p></div></li>
              <li><span aria-hidden="true">02</span><div><strong>Controlled local tools</strong><p>Typed writes, permissions, and idempotency.</p></div></li>
              <li><span aria-hidden="true">03</span><div><strong>Sandbox communication</strong><p>Exact approval required for the local outbox.</p></div></li>
            </ul>
          </section>
        </div>
        <aside className="boundary-note"><span className="note-icon" aria-hidden="true">i</span><div><strong>Backend runtime available</strong><p>This dashboard displays live service health. Autonomous runs, durable approval decisions, and independent verification are available through the backend API. Run controls arrive in Phase 4; email remains a local sandbox.</p></div></aside>
      </main>
      <footer><span>CentrAlign Operator</span><span>Goal → Execute → Verify · Backend execution loop</span></footer>
    </div>
  );
}
