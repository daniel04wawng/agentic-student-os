/**
 * TypeScript mirror of the database enums and table names defined in
 * `supabase/migrations/0001_core_world_state.sql`. The SQL migration is the
 * single source of truth; these constants exist for typed application code and
 * are kept honest by a drift test that compares them to the live DB enums.
 *
 * PR 1 defines structure only. No query helpers or ORM live here yet.
 */

import { PROVIDERS, type Provider } from '@student-os/shared';

// Provider vocabulary is shared (used by the event envelope too); re-exported
// here so DB_ENUMS stays a single place. The drift test validates it vs the DB.
export { PROVIDERS, type Provider };

export const COURSE_STATUSES = ['upcoming', 'active', 'archived'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const PERSON_ROLES = ['self', 'instructor', 'ta', 'classmate', 'other'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const SESSION_KINDS = [
  'lecture',
  'section',
  'office_hours',
  'group_meeting',
  'exam',
  'other',
] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_STATUSES = ['scheduled', 'in_progress', 'completed', 'canceled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  'not_started',
  'planning',
  'context_pending',
  'context_ready',
  'generating',
  'review_ready',
  'approved',
  'submitted',
  'archived',
  'blocked',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DELIVERABLE_KINDS = [
  'essay',
  'problem_set',
  'presentation',
  'code',
  'exam',
  'other',
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const DELIVERABLE_STATUSES = [
  'pending',
  'in_progress',
  'review_ready',
  'approved',
  'submitted',
  'archived',
] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const ARTIFACT_KINDS = [
  'google_doc',
  'google_sheet',
  'google_slides',
  'file',
  'text',
  'other',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_STATUSES = ['draft', 'review_ready', 'approved', 'submitted', 'archived'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ADMIN_KINDS = ['email', 'scheduling', 'form', 'payment', 'other'] as const;
export type AdminKind = (typeof ADMIN_KINDS)[number];

export const ADMIN_STATUSES = ['open', 'in_progress', 'done', 'dismissed'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export const DEVICE_PLATFORMS = ['ios', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const NOTIFICATION_KINDS = ['review_ready', 'deadline', 'admin', 'info'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_STATUSES = ['pending', 'delivered', 'failed', 'dismissed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const RECORDING_STATUSES = ['pending', 'uploading', 'stored', 'failed'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const TRANSCRIPTION_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

export const SUMMARY_SCOPES = ['section', 'session', 'course'] as const;
export type SummaryScope = (typeof SUMMARY_SCOPES)[number];

export const READINESS_STATUSES = ['pending', 'ready'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const CLASS_PREP_STATUSES = ['pending', 'ready', 'failed'] as const;
export type ClassPrepStatus = (typeof CLASS_PREP_STATUSES)[number];

export const WRITING_SAMPLE_SOURCES = ['self', 'instructor', 'exemplar'] as const;
export type WritingSampleSource = (typeof WRITING_SAMPLE_SOURCES)[number];

/** Postgres enum type name -> ordered label list. Used by the drift test. */
export const DB_ENUMS = {
  provider: PROVIDERS,
  course_status: COURSE_STATUSES,
  person_role: PERSON_ROLES,
  session_kind: SESSION_KINDS,
  session_status: SESSION_STATUSES,
  assignment_status: ASSIGNMENT_STATUSES,
  project_status: PROJECT_STATUSES,
  deliverable_kind: DELIVERABLE_KINDS,
  deliverable_status: DELIVERABLE_STATUSES,
  artifact_kind: ARTIFACT_KINDS,
  artifact_status: ARTIFACT_STATUSES,
  admin_kind: ADMIN_KINDS,
  admin_status: ADMIN_STATUSES,
  device_platform: DEVICE_PLATFORMS,
  notification_kind: NOTIFICATION_KINDS,
  notification_status: NOTIFICATION_STATUSES,
  recording_status: RECORDING_STATUSES,
  transcription_status: TRANSCRIPTION_STATUSES,
  summary_scope: SUMMARY_SCOPES,
  readiness_status: READINESS_STATUSES,
  class_prep_status: CLASS_PREP_STATUSES,
  writing_sample_source: WRITING_SAMPLE_SOURCES,
} as const satisfies Record<string, readonly string[]>;

/** Canonical table names in the world-state schema. */
export const TABLES = [
  'courses',
  'people',
  'sessions',
  'assignments',
  'projects',
  'deliverables',
  'artifacts',
  'admin_items',
  'events',
  'course_profiles',
  'devices',
  'notifications',
  'recordings',
  'transcripts',
  'transcript_chunks',
  'summaries',
  'readiness_contracts',
  'class_preps',
  'writing_samples',
] as const;
export type TableName = (typeof TABLES)[number];
