import { useMemo } from 'react';
import type { DocumentTemplateBody, TemplateKind } from '@billme/server-core/domain';
import { buildDocumentViewModel, sampleRenderInput, type DocumentRenderInput } from '@billme/desktop-utils/document';
import { useSettingsQuery } from './useSettings';

/**
 * A sample document of the given kind rendered with the template. Uses the
 * user's own company data once it exists, so the preview shows their letterhead.
 */
export const useTemplatePreviewModel = (kind: TemplateKind, body: DocumentTemplateBody, options: { longItems?: boolean } = {}) => {
  const { data: settings } = useSettingsQuery();
  const longItems = Boolean(options.longItems);
  return useMemo(() => {
    const sample = sampleRenderInput(kind, { longItems });
    const own = settings?.company?.name?.trim() ? (settings as unknown as DocumentRenderInput['settings']) : null;
    return buildDocumentViewModel({ ...sample, settings: own ?? sample.settings, template: body });
  }, [body, kind, longItems, settings]);
};
