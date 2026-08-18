/** Shared parsing and lookup helpers for workflow policy tests. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '..')

/**
 * Loads a repository workflow and rejects non-object YAML documents.
 *
 * @param path Repository-relative workflow path.
 * @returns Parsed workflow record.
 */
export function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

/**
 * Returns a configured workflow event and rejects missing or scalar event entries.
 *
 * @param workflow Parsed workflow record.
 * @param event Event name to read.
 * @returns Configured event record.
 */
export function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

/**
 * Returns a configured workflow job and rejects missing or scalar job entries.
 *
 * @param workflow Parsed workflow record.
 * @param job Job id to read.
 * @returns Configured job record.
 */
export function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

/**
 * Narrows an unknown value to a non-array object record.
 *
 * @param value Value to inspect.
 * @returns Whether `value` is a non-array object record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
