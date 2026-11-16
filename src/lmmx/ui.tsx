// Small shared pieces for the Lipa Mdogo Mdogo screens (Tailwind, mobile first, large touch targets).
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <section className={`bg-white rounded-xl shadow-md p-5 sm:p-6 ${className}`}>{children}</section>
);

export const Title = ({ children }: { children: ReactNode }) => <h2 className="text-lg font-bold text-gray-900">{children}</h2>;

export function Btn({ tone = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' }) {
  const look = tone === 'primary' ? 'bg-green-600 text-white hover:bg-green-700' : tone === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-gray-100 text-gray-800 hover:bg-gray-200';
  return <button type="button" {...p} className={`min-h-11 px-4 py-2 rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${look} ${className}`} />;
}

export const Alert = ({ kind, children }: { kind: 'ok' | 'err' | 'warn' | 'info'; children: ReactNode }) => {
  const look = kind === 'ok' ? 'border-green-300 bg-green-50 text-green-900' : kind === 'err' ? 'border-red-300 bg-red-50 text-red-800' : kind === 'warn' ? 'border-yellow-300 bg-yellow-50 text-yellow-900' : 'border-blue-200 bg-blue-50 text-blue-900';
  return <div role={kind === 'err' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm break-words ${look}`}>{children}</div>;
};

export const Field = ({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) => (
  <label className="block text-sm text-gray-700">
    <span className="font-medium">{label}</span>
    <span className="mt-1 block">{children}</span>
    {error ? <span role="alert" className="mt-1 block text-xs text-red-600 font-medium">{error}</span> : hint ? <span className="mt-1 block text-xs text-gray-500">{hint}</span> : null}
  </label>
);

export const inputClass = 'w-full min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-green-600';

export const Spinner = ({ label }: { label: string }) => (
  <div role="status" className="flex items-center gap-2 text-sm text-gray-600 p-4"><span className="h-4 w-4 rounded-full border-2 border-green-600 border-t-transparent animate-spin" aria-hidden />{label}</div>
);

export const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex justify-between gap-3 py-1.5 text-sm"><dt className="text-gray-600">{label}</dt><dd className="font-semibold text-gray-900 text-right">{children}</dd></div>
);

/** "Thu 5 Dec, 14:30" in Nairobi time, from epoch ms. */
export const when = (ms: number): string => new Date(ms).toLocaleString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });
