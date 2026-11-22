import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Card, Shell } from './ui';

interface Props { children: ReactNode; resetKey: string }
interface State { error: Error | null; key: string }

/**
 * Fängt Renderfehler einer Seite ab: statt eines schwarzen Bildschirms (React entfernt sonst den ganzen Baum)
 * erscheint eine Fehlerkarte mit „Zurück“ und „Neu laden“. Beim Seitenwechsel wird automatisch zurückgesetzt.
 */
class Boundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }
  static getDerivedStateFromProps(p: Props, s: State): Partial<State> | null {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null;
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Seitenfehler]', error, info.componentStack);
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Shell>
        <div data-testid="page-error"><Card className="mx-auto max-w-lg space-y-4">
          <h1 className="display text-3xl font-bold uppercase">Seite konnte nicht angezeigt werden</h1>
          <p className="text-cream-dim">Beim Anzeigen ist ein Fehler aufgetreten. Dein Spielstand ist nicht betroffen.</p>
          <p className="break-words font-mono text-xs text-cream-dim">{error.message}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => window.history.back()}>← Zurück</Button>
            <Button onClick={() => window.location.reload()}>Neu laden</Button>
          </div>
        </Card></div>
      </Shell>
    );
  }
}

export function PageErrorBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return <Boundary resetKey={loc.pathname}>{children}</Boundary>;
}
