import { CatalogBrowser } from "@/components/catalog-browser";
import { CauseSearch } from "@/components/cause-search";

export default function CausesPage() {
  return (
    <section>
      <h1>Causes</h1>
      <p>
        Every compliant Endaoment organization is in the cause catalogue, grouped by cause and by region. Tokens choose a focus at
        launch and their ballots draw from the matching organizations.
      </p>
      <h2>Browse the catalogue</h2>
      <CatalogBrowser />
      <h2>Search Endaoment by name</h2>
      <CauseSearch />
    </section>
  );
}
