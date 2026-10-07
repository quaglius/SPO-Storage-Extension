import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useV2LabRun } from '../api/v2.js';
import { defaultDefinition, PolicyBuilder } from '../components/PolicyBuilder.js';
import { useToast } from '../app/toast.js';
import { ApiClientError } from '../api/client.js';

export function LabPage() {
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [definition, setDefinition] = useState<Record<string, unknown>>(defaultDefinition('archive_files'));
  const labRun = useV2LabRun();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Lab</h1>
        <p className="mt-1 text-sm text-muted">
          Try a policy on specific files or sites (max 20 actions) with evidence.
        </p>
      </div>

      <PolicyBuilder
        mode="lab"
        definition={definition}
        onChange={setDefinition}
        labRunPending={labRun.isPending}
        onCreateLabRun={(payload) =>
          void labRun
            .mutateAsync(payload)
            .then((run) => {
              pushToast('Lab run created', 'success');
              navigate(`/runs/${run.id}`);
            })
            .catch((err: unknown) =>
              pushToast(err instanceof ApiClientError ? err.message : 'Error', 'error'),
            )
        }
      />
    </div>
  );
}
