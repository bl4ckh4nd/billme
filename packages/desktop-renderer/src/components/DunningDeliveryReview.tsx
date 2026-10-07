import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input } from '@billme/ui';
import { ipc } from '../runtime-api';

export const DunningDeliveryReview: React.FC = () => {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['dunning-deliveries'], queryFn: () => ipc.dunning.listDeliveries() });
  const [reason, setReason] = React.useState<Record<string, string>>({});
  const resolve = useMutation({ mutationFn: (input: { id: string; accepted: boolean; reason: string }) => ipc.dunning.resolveDelivery(input), onSuccess: async () => { await Promise.all(['dunning-deliveries', 'invoices'].map((key) => client.invalidateQueries({ queryKey: [key] }))); } });
  if (!query.isError && !query.data?.length) return null;
  return <Card><h3 className="text-section">Unklaren Mahnversand prüfen</h3>
    {query.isError && <p role="alert" className="text-control text-error-text">Versandzustände konnten nicht geladen werden.</p>}
    {query.data?.map((delivery) => <div key={delivery.id} className="mt-4 flex flex-col gap-3 border-t border-border pt-3"><p className="text-control">{delivery.invoiceNumber} · Mahnstufe {delivery.level}. Ein erneuter Versand ist gesperrt. Prüfen Sie beim E-Mail-Anbieter, ob die Mahnung angenommen wurde.</p><Input label={`Prüfnachweis für ${delivery.invoiceNumber}`} value={reason[delivery.id] ?? ''} onChange={(e) => setReason({ ...reason, [delivery.id]: e.target.value })} placeholder="z. B. Anbieterprotokoll und Zeitpunkt" /><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={!reason[delivery.id]?.trim() || resolve.isPending} onClick={() => resolve.mutate({ id: delivery.id, accepted: true, reason: reason[delivery.id] })}>Annahme bestätigt</Button><Button variant="secondary" disabled={!reason[delivery.id]?.trim() || resolve.isPending} onClick={() => resolve.mutate({ id: delivery.id, accepted: false, reason: reason[delivery.id] })}>Nicht angenommen – Wiederholung freigeben</Button></div></div>)}
    {resolve.isError && <p role="alert" className="mt-3 text-control text-error-text">{resolve.error.message}</p>}
  </Card>;
};
