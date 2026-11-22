import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Calendar } from './pages/Calendar';
import { ClubPage } from './pages/ClubPage';
import { Development } from './pages/Development';
import { MatchdayOverview } from './pages/MatchdayOverview';
import { PlayerPage } from './pages/PlayerPage';
import { AuthProvider, useAuth } from './lib/auth';
import { missingEnv } from './lib/supabase';
import { Button, Card, Shell, Spinner } from './components/ui';
import { PageErrorBoundary } from './components/ErrorBoundary';
import { Account } from './pages/Account';
import { ClubEditor } from './pages/ClubEditor';
import { Draft } from './pages/Draft';
import { Team } from './pages/Team';
import { Match } from './pages/Match';
import { Matchday } from './pages/Matchday';
import { League } from './pages/League';
import { Cup } from './pages/Cup';
import { Europe } from './pages/Europe';
import { FanCulture } from './pages/FanCulture';
import { Transfers } from './pages/Transfers';
import { Contracts } from './pages/Contracts';
import { Finance } from './pages/Finance';
import { Home } from './pages/Home';
import { Lobby } from './pages/Lobby';
import { ProfileSetup, ResetPassword, Welcome } from './pages/Welcome';
import { AccountNotices } from './components/SecureAccount';

function Routed() {
  return (
    <>
      <AccountNotices />
      <RoutedInner />
    </>
  );
}

function RoutedInner() {
  const { loading, session, profile, profileError, recovery, refreshProfile } = useAuth();
  if (loading) return <Spinner label="Verbinde …" />;
  if (recovery) return <ResetPassword />;
  if (!session) return <Welcome />;
  // Profil nicht ladbar (z. B. offline): Sitzung behalten, NICHT zur Anmeldung leiten – sonst könnte ein
  // ungesicherter Account durch eine neue Anmeldung überschrieben werden.
  if (profileError) {
    return (
      <Shell>
        <Card className="mx-auto max-w-md space-y-4">
          <h1 className="display text-3xl font-bold uppercase">Keine Verbindung</h1>
          <p className="text-cream-dim">Dein Account konnte nicht geladen werden. Deine Daten sind sicher – bitte versuche es erneut.</p>
          <Button onClick={() => void refreshProfile()}>Erneut versuchen</Button>
        </Card>
      </Shell>
    );
  }
  if (!profile) return session.user.is_anonymous ? <Welcome /> : <ProfileSetup />;
  return (
    <PageErrorBoundary>
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
      <Route path="/w/:worldId/europa" element={<Europe />} />
      <Route path="/w/:worldId/fankultur" element={<FanCulture />} />
      <Route path="/w/:worldId/transfers" element={<Transfers />} />
      <Route path="/w/:worldId/finanzen" element={<Finance />} />
      <Route path="/w/:worldId/vertraege" element={<Contracts />} />
      <Route path="/w/:worldId/kalender" element={<Calendar />} />
      <Route path="/w/:worldId/uebersicht/:slotId" element={<MatchdayOverview />} />
      <Route path="/w/:worldId/spieler/:playerId" element={<PlayerPage />} />
      <Route path="/w/:worldId/club/:clubId" element={<ClubPage />} />
      <Route path="/w/:worldId/entwicklung" element={<Development />} />
      <Route path="/w/:worldId/entwicklung/:clubId" element={<Development />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </PageErrorBoundary>
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
