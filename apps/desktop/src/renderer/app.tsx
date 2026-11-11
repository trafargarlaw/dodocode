import { Badge } from "@dodocode/ui/components/badge";

export function App() {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2">
      <h1 className="font-heading text-2xl font-semibold">dodocode</h1>
      <Badge variant="secondary">{window.dodocode.platform}</Badge>
    </main>
  );
}
