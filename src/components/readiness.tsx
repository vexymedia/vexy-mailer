export function Readiness({ problems }: { problems: string[] }) {
  if (problems.length === 0) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        Připraveno ke spuštění.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-medium">Než kampaň půjde spustit:</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
        {problems.map((problem, index) => (
          <li key={index}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}
