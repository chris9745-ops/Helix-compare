import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getFormList } from './api';
import { DATA_PRESETS } from './presets';

// Form names to suggest in any form-name box: the common presets first, then every
// form from the list imported for this connection (if the user has imported one).
export function useFormNames(connectionId) {
  const { data } = useQuery({
    queryKey: ['formList', connectionId],
    queryFn: () => getFormList(connectionId),
    enabled: !!connectionId,
    staleTime: 5 * 60 * 1000,
    retry: false
  });

  const imported = data?.forms;
  const names = useMemo(() => {
    const all = new Set(DATA_PRESETS.map(p => p.formName));
    for (const f of imported || []) all.add(f.name);
    return [...all];
  }, [imported]);

  return { names, importedCount: imported?.length || 0, importedAt: data?.importedAt || null };
}
