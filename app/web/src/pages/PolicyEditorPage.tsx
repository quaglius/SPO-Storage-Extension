import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  useV2CreatePolicy,
  useV2CreatePolicyRun,
  useV2Policies,
  useV2UpdatePolicy,
} from '../api/v2.js';
import { defaultDefinition, PolicyBuilder } from '../components/PolicyBuilder.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { useToast } from '../app/toast.js';
import { ApiClientError } from '../api/client.js';

export function PolicyEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === 'nueva' || id === 'new';
  const policyId = isNew ? null : Number(id);
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const { data: list, isLoading } = useV2Policies();
  const existing = list?.items.find((p) => p.id === policyId);

  const [name, setName] = useState('');
  const [definition, setDefinition] = useState<Record<string, unknown>>(defaultDefinition('delete_versions'));

  const create = useV2CreatePolicy();
  const update = useV2UpdatePolicy();
  const createRun = useV2CreatePolicyRun();

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDefinition(existing.definition as Record<string, unknown>);
    }
  }, [existing]);

  if (!isNew && isLoading && !existing) return <PageSkeleton />;

  const save = async (): Promise<number> => {
    if (!name.trim()) throw new Error('Name is required');
    if (isNew) {
      const p = await create.mutateAsync({ name: name.trim(), definition });
      pushToast('Policy created', 'success');
      navigate(`/policies/${p.id}`, { replace: true });
      return p.id;
    }
    await update.mutateAsync({ id: policyId!, name: name.trim(), definition });
    pushToast('Policy saved', 'success');
    return policyId!;
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/policies" className="text-sm text-accent hover:underline">
          ← Policies
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{isNew ? 'New policy' : 'Edit policy'}</h1>
      </div>

      <label className="block max-w-lg text-sm">
        <span className="text-muted">Name</span>
        <input
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <PolicyBuilder
        mode="policy"
        definition={definition}
        onChange={setDefinition}
        savePending={create.isPending || update.isPending}
        planPending={createRun.isPending}
        onSavePolicy={() => void save().catch((e: Error) => pushToast(e.message, 'error'))}
        onCreatePlan={() =>
          void save()
            .then((pid) => createRun.mutateAsync(pid))
            .then((run) => {
              pushToast('Execution plan created', 'success');
              navigate(`/runs/${run.id}`);
            })
            .catch((err: unknown) => {
              pushToast(err instanceof ApiClientError ? err.message : 'Could not create the plan', 'error');
            })
        }
      />
    </div>
  );
}
