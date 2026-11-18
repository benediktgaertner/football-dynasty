import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-gold text-ink hover:brightness-105 active:brightness-95 shadow-[0_4px_0_0_#b8902f]',
  secondary: 'bg-olive-700 text-cream hover:bg-olive-600 border border-olive-600',
  ghost: 'bg-transparent text-cream-dim hover:text-cream hover:bg-olive-800',
  danger: 'bg-transparent text-danger border border-danger/50 hover:bg-danger/10',
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={`display inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 text-lg font-semibold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-olive-700/80 bg-olive-900/85 p-5 shadow-xl backdrop-blur ${className}`}>{children}</div>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="display mb-1 block text-sm font-semibold uppercase tracking-wider text-cream-dim">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-sm text-danger">{error}</span> : hint ? <span className="mt-1 block text-sm text-cream-dim/70">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`min-h-11 w-full rounded-xl border border-olive-600 bg-anthracite px-4 text-lg text-cream placeholder:text-cream-dim/40 focus:border-gold focus:outline-none ${props.className ?? ''}`}
    />
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3 text-cream">
      {error}
    </div>
  );
}

export function Spinner({ label = 'Lädt …' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 p-10 text-cream-dim">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-gold border-t-transparent" aria-hidden />
      {label}
    </div>
  );
}

export function Shell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col px-4 pb-10 pt-[max(env(safe-area-inset-top),1rem)] sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-10 w-10" />
          <span className="display text-2xl font-extrabold uppercase tracking-wide">
            Football <span className="text-gold">Dynasty</span>
          </span>
        </Link>
        <div className="flex items-center gap-2">{right}</div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'gold' }) {
  const tones = {
    neutral: 'bg-olive-700 text-cream-dim',
    good: 'bg-pitch text-cream',
    warn: 'bg-sunset/20 text-sunset',
    gold: 'bg-gold/15 text-gold',
  };
  return <span className={`display rounded-full px-3 py-0.5 text-sm font-semibold uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
}
