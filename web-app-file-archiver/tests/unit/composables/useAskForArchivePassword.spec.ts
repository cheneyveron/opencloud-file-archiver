import { useModals } from '@opencloud-eu/web-pkg'
import { defaultComponentMocks, getComposableWrapper } from '@opencloud-eu/web-test-helpers'
import { useAskForArchivePassword } from '../../../src/composables/useAskForArchivePassword'

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({ $gettext: (value: string) => value })
}))

describe('ask for archive password', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the current modal can close', async () => {
    const askForArchivePassword = getAskForArchivePassword()
    const { dispatchModal } = useModals()
    vi.mocked(dispatchModal).mockImplementation((modal) => ({ ...modal, id: 'modal-id' }))

    const promise = askForArchivePassword()
    let resolved = false
    promise.then(() => {
      resolved = true
    })

    const modal = vi.mocked(dispatchModal).mock.calls[0][0]
    modal.onConfirm?.('archive-password')

    await Promise.resolve()
    expect(resolved).toBe(false)

    vi.runOnlyPendingTimers()
    await expect(promise).resolves.toBe('archive-password')
  })
})

function getAskForArchivePassword() {
  const mocks = { ...defaultComponentMocks() }
  let askForArchivePassword!: () => Promise<string | null>
  getComposableWrapper(
    () => {
      askForArchivePassword = useAskForArchivePassword().askForArchivePassword
    },
    {
      mocks,
      provide: mocks
    }
  )
  return askForArchivePassword
}
