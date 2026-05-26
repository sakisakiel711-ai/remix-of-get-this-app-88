import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2, CheckCircle2, XCircle, ArrowRight } from "lucide-react";
import { verifyCinetPayPayment } from "@/lib/cinetpay.functions";

const searchSchema = z.object({ tx: z.string().optional() });

export const Route = createFileRoute("/payment/cinetpay-callback")({
  head: () => ({ meta: [{ title: "Confirmation du paiement — VinaSound" }] }),
  validateSearch: searchSchema,
  component: CallbackPage,
});

function CallbackPage() {
  const { tx } = useSearch({ from: "/payment/cinetpay-callback" });
  const verify = useServerFn(verifyCinetPayPayment);

  const { data, isLoading, error } = useQuery({
    queryKey: ["cinetpay-verify", tx],
    queryFn: () => verify({ data: { transaction_id: tx! } }),
    enabled: !!tx,
    retry: 1,
  });

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6">
      <div className="max-w-md w-full rounded-xl border border-border bg-card p-8 text-center">
        {!tx ? (
          <>
            <XCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
            <h1 className="font-display text-xl font-bold mb-2">Référence manquante</h1>
            <p className="text-sm text-muted-foreground mb-5">
              Aucune transaction à vérifier.
            </p>
          </>
        ) : isLoading ? (
          <>
            <Loader2 className="w-10 h-10 text-primary mx-auto mb-3 animate-spin" />
            <h1 className="font-display text-xl font-bold mb-2">Vérification du paiement…</h1>
            <p className="text-sm text-muted-foreground">Merci de patienter quelques secondes.</p>
          </>
        ) : error ? (
          <>
            <XCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
            <h1 className="font-display text-xl font-bold mb-2">Erreur</h1>
            <p className="text-sm text-muted-foreground mb-5">
              {(error as Error).message || "Impossible de vérifier la transaction."}
            </p>
          </>
        ) : data?.success ? (
          <>
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <h1 className="font-display text-xl font-bold mb-2">Paiement confirmé 🎉</h1>
            <p className="text-sm text-muted-foreground mb-5">
              {data.kind === "subscription"
                ? "Ton abonnement PRO est maintenant actif."
                : "Ton achat a bien été enregistré."}
            </p>
          </>
        ) : (
          <>
            <XCircle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
            <h1 className="font-display text-xl font-bold mb-2">Paiement non confirmé</h1>
            <p className="text-sm text-muted-foreground mb-5">
              Si tu as bien payé, la confirmation peut prendre quelques minutes. Reviens sur cette
              page dans un instant ou contacte le support.
            </p>
          </>
        )}

        <div className="flex gap-2 justify-center">
          <Link
            to="/subscription"
            className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground rounded-full px-5 py-2 text-sm font-bold hover:bg-primary/90 transition"
          >
            Mon abonnement <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            to="/"
            className="inline-flex items-center rounded-full border border-border px-5 py-2 text-sm font-bold hover:bg-surface transition"
          >
            Accueil
          </Link>
        </div>
      </div>
    </div>
  );
}
