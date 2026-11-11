export function App() {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-1">
      <h1 className="font-heading text-2xl font-semibold">dodocode</h1>
      <p className="text-sm text-muted-foreground">Running on {window.dodocode.platform}</p>
    </main>
  );
}
