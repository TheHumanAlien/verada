import { LaunchForm } from "@/components/launch-form";

export default function LaunchPage() {
  return (
    <section>
      <h1>Launch a token</h1>
      <p>Tokens launch cause-agnostic. Holders vote weekly on which nonprofit receives the cause share of fees.</p>
      <LaunchForm />
    </section>
  );
}
