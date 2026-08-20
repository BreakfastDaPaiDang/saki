import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { IntentReceipt, ProjectionEnvelope, SakiIntent } from '../contract/types'
import { FixtureControlPlane } from '../fixtures/engine'
import { getScenario, scenarios, type ScenarioDef } from '../fixtures/scenarios'

/**
 * React binding over the fixture control plane. Components read complete
 * Projections through useProjection and submit typed Intents through
 * useSubmitIntent; they never join records or infer buttons from raw status.
 */

interface ControlPlaneContextValue {
  engine: FixtureControlPlane
  scenario: ScenarioDef
  switchScenario: (id: string) => void
  allScenarios: ScenarioDef[]
}

export interface IntentSubmission {
  receipt: IntentReceipt
  /** True while the outcome is still pending (transport timeout is not a product failure). */
  pending: boolean
}

interface IntentContextValue {
  /**
   * Submit a typed Intent with the expected revision of the Projection it
   * read. The receipt id is stable from pending to terminal; an identical
   * in-flight submission reuses the same receipt.
   */
  submit: (intent: SakiIntent, options: SubmitOptions) => Promise<IntentReceipt>
  submissions: IntentSubmission[]
  dismiss: (receiptId: string) => void
}

const ControlPlaneContext = createContext<ControlPlaneContextValue | null>(null)
const IntentContext = createContext<IntentContextValue | null>(null)

export function ControlPlaneProvider(props: { scenarioId: string | null; onScenarioChange: (id: string) => void; children: ReactNode }) {
  const [scenario, setScenario] = useState<ScenarioDef>(() => getScenario(props.scenarioId))
  const engine = useMemo(() => {
    const next = new FixtureControlPlane()
    scenario.install(next)
    return next
  }, [scenario])

  const [submissions, setSubmissions] = useState<IntentSubmission[]>([])

  // Scenario switches tear down the engine; outstanding receipts go with it.
  useEffect(() => setSubmissions([]), [engine])

  const submit = useCallback(
    async (intent: SakiIntent, options: SubmitOptions): Promise<IntentReceipt> => {
      const handle = engine.submit(intent, options)
      // The receipt id is minted synchronously and stays stable from pending
      // to terminal — no placeholder id is ever replaced.
      setSubmissions((list) => [
        ...list,
        { receipt: { receiptId: handle.receiptId, intent, submittedAt: '', outcome: null }, pending: true },
      ])
      const receipt = await handle.done
      setSubmissions((list) => list.map((s) => (s.receipt.receiptId === handle.receiptId ? { receipt, pending: false } : s)))
      return receipt
    },
    [engine],
  )

  const dismiss = useCallback((receiptId: string) => {
    setSubmissions((list) => list.filter((s) => s.receipt.receiptId !== receiptId))
  }, [])

  const switchScenario = useCallback(
    (id: string) => {
      const next = getScenario(id)
      setScenario(next)
      props.onScenarioChange(next.id)
    },
    [props],
  )

  const value = useMemo(
    () => ({ engine, scenario, switchScenario, allScenarios: scenarios }),
    [engine, scenario, switchScenario],
  )
  const intentValue = useMemo(() => ({ submit, submissions, dismiss }), [submit, submissions, dismiss])

  return (
    <ControlPlaneContext.Provider value={value}>
      <IntentContext.Provider value={intentValue}>{props.children}</IntentContext.Provider>
    </ControlPlaneContext.Provider>
  )
}

export function useControlPlane(): ControlPlaneContextValue {
  const ctx = useContext(ControlPlaneContext)
  if (!ctx) throw new Error('useControlPlane outside provider')
  return ctx
}

export interface ProjectionState<T> {
  envelope: ProjectionEnvelope<T> | null
  /** True while a re-query following invalidation is in flight. */
  refreshing: boolean
  error: string | null
  refresh: () => void
}

export function useProjection<T>(key: string): ProjectionState<T> {
  const { engine } = useControlPlane()
  const [envelope, setEnvelope] = useState<ProjectionEnvelope<T> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(
    (initial: boolean) => {
      const gen = ++generation.current
      setRefreshing(!initial)
      engine
        .query<T>(key)
        .then((result) => {
          if (generation.current !== gen) return
          setEnvelope(result)
          setRefreshing(false)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (generation.current !== gen) return
          setError(cause instanceof Error ? cause.message : String(cause))
          setRefreshing(false)
        })
    },
    [engine, key],
  )

  useEffect(() => {
    setEnvelope(null)
    load(true)
    // onChanged invalidates keys; the client always re-queries the complete
    // Projection rather than applying deltas.
    return engine.onChanged((keys) => {
      if (keys.includes(key)) load(false)
    })
  }, [engine, key, load])

  return { envelope, refreshing, error, refresh: () => load(false) }
}

export function useSubmitIntent(): IntentContextValue {
  const ctx = useContext(IntentContext)
  if (!ctx) throw new Error('useSubmitIntent outside provider')
  return ctx
}

/** What every submit call needs: the revision of the Projection it read. */
export interface SubmitOptions {
  expectedRevision: number
  subject: string
}
