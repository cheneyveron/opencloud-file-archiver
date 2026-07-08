import { useModals } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'

function resolveAfterModalClose<T>(resolve: (value: T) => void, value: T) {
  setTimeout(() => resolve(value), 0)
}

function getArchiveNameSelectionRange(fileName: string): [number, number] {
  const lowerFileName = fileName.toLowerCase()
  if (lowerFileName.endsWith('.tar.gz')) {
    return [0, fileName.length - '.tar.gz'.length]
  }

  const extensionStart = fileName.lastIndexOf('.')
  if (extensionStart > 0) {
    return [0, extensionStart]
  }

  return [0, fileName.length]
}

export const useAskForArchiveFileName = () => {
  const { $gettext } = useGettext()
  const { dispatchModal, updateModal } = useModals()

  function askForArchiveFileName(suggestedFileName: string): Promise<string | null> {
    return new Promise((resolve) => {
      let modalId = ''
      const modal = dispatchModal({
        title: $gettext('Create archive'),
        message: $gettext('Enter a name for the archive.'),
        confirmText: $gettext('Continue'),
        hasInput: true,
        inputType: 'text',
        inputValue: suggestedFileName,
        inputSelectionRange: getArchiveNameSelectionRange(suggestedFileName),
        inputLabel: $gettext('Archive name'),
        inputRequiredMark: true,
        confirmDisabled: !suggestedFileName.trim(),
        onInput: (value: string, setError: (error: string) => void) => {
          const isEmpty = !value.trim()
          setError(isEmpty ? $gettext('Archive name is required') : '')
          updateModal(modalId, 'confirmDisabled', isEmpty)
        },
        onConfirm: (value: string) => {
          resolveAfterModalClose(resolve, value?.trim() || null)
        },
        onCancel: () => {
          resolveAfterModalClose(resolve, null)
        }
      })
      modalId = modal.id
    })
  }

  return {
    askForArchiveFileName
  }
}
