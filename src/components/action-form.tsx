"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import type { ActionState } from "@/lib/actions";

/**
 * Wraps a server action with pending state and a consistent place to render
 * the error / success message it returns.
 */
export function ActionForm({
  action,
  children,
  className,
  hideMessages,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: ReactNode | ((state: ActionState) => ReactNode);
  className?: string;
  hideMessages?: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className}>
      {!hideMessages ? <Messages state={state} /> : null}
      {typeof children === "function" ? children(state) : children}
    </form>
  );
}

export function Messages({ state }: { state: ActionState }) {
  if (!state.error && !state.success && !state.problems?.length) return null;
  return (
    <div className="mb-4 space-y-3">
      {state.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      ) : null}
      {state.success ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {state.success}
        </div>
      ) : null}
      {state.problems?.length ? (
        <ul className="list-disc space-y-1 rounded-md border border-amber-200 bg-amber-50 px-8 py-3 text-sm text-amber-900">
          {state.problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SubmitButton({
  children,
  className = "btn-primary",
  pendingLabel,
  confirm,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
  confirm?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={className}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
      {...rest}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
