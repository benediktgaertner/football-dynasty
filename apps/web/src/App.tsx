import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { missingEnv } from './lib/supabase';
import { Card, Shell, Spinner } from './components/ui';
import { Account } from './pages/Account';
import { ClubEditor } from './pages/ClubEditor';
import { Draft } from './pages/Draft';
import { Team } from './pages/Team';
import { Match } from './pages/Match';
import { Matchday } from './pages/Matchday';
import { League } from './pages/League';
import { Cup } from './pages/Cup';
import { Transfers } from './pages/Transfers';
import { Finance } from './pages/Finance';
import { Home } from './pages/Home';
import { Lobby } from './pages/Lobby';
import { Welcome } from './pages/Welcome';

function Routed() {
  const { loading, session, profile } = useAuth();
  if (loading) return <Spinner label="Verbinde …" />;
  if (!session || !profile) return <Welcome />;
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/konto" element={<Account />} />
      <Route path="/w/:worldId" element={<Lobby />} />
      <Route path="/w/:worldId/verein" element={<ClubEditor />} />
      <Route path="/w/:worldId/draft" element={<Draft />} />
      <Route path="/w/:worldId/team" element={<Team />} />
      <Route path="/w/:worldId/match/:fixtureId" element={<Match />} />
      <Route path="/w/:worldId/spieltag" element={<Matchday />} />
      <Route path="/w/:worldId/liga" element={<League />} />
      <Route path="/w/:worldId/pokal" element={<Cup />} />
      <Route path="/w/:worldId/transfers" element={<Transfers />} />
      <Route path="/w/:worldId/finanzen" element={<Finance />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** O4: Ohne Zugangsdaten zeigt die App genau an, was fehlt – statt Funktionen vorzutäuschen. */
function ConfigMissing() {
  return (
    <Shell>
      <Card className="mx-auto max-w-xl">
        <h1 className="display text-3xl font-bold uppercase">Konfiguration fehlt</h1>
        <p className="mt-3 text-cream-dim">Folgende Umgebungsvariablen waren beim Build nicht gesetzt:</p>
        <ul className="mt-3 list-inside list-disc font-mono text-gold">
          {missingEnv.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
        <p className="mt-4 text-cream-dim">
          Netlify: Site configuration → Environment variables → Werte eintragen, danach unter Deploys „Trigger deploy → Clear cache and
          deploy site“. Vite übernimmt die Werte nur beim Build, ein Neuladen der Seite reicht nicht.
        </p>
      </Card>
    </Shell>
  );
}

export function App() {
  // Der Router umschließt alles, auch die Hinweisseite – sie enthält Links (Shell).
  return (
    <BrowserRouter>
      {missingEnv.length > 0 ? (
        <ConfigMissing />
      ) : (
        <AuthProvider>
          <Routed />
        </AuthProvider>
      )}
    </BrowserRouter>
  );
}
