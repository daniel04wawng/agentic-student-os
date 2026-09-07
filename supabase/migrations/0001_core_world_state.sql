-- 0001_core_world_state
-- Core Student World State (PR 1). Canonical relational schema for the domain.
-- No queries, ingestion, or state-transition enforcement live here; this is
-- structure + constraints only. Deadline columns store the source timezone
-- separately from the instant (the reconciliation engine is PR 6). Event
-- idempotency/replay is intentionally deferred to PR 2.

-- ---------------------------------------------------------------------------
-- Enums (status/state + provenance source). Values are defined generously up
-- front because Postgres cannot add/remove enum values inside a transaction;
-- later PRs enforce the transitions between them.
-- ---------------------------------------------------------------------------
CREATE TYPE provider AS ENUM ('canvas', 'google', 'outlook', 'deepgram', 'manual', 'system');

CREATE TYPE course_status AS ENUM ('upcoming', 'active', 'archived');

CREATE TYPE person_role AS ENUM ('self', 'instructor', 'ta', 'classmate', 'other');

CREATE TYPE session_kind AS ENUM ('lecture', 'section', 'office_hours', 'group_meeting', 'exam', 'other');
CREATE TYPE session_status AS ENUM ('scheduled', 'in_progress', 'completed', 'canceled');

CREATE TYPE assignment_status AS ENUM (
  'not_started', 'planning', 'context_pending', 'context_ready',
  'generating', 'review_ready', 'approved', 'submitted', 'archived', 'blocked'
);

CREATE TYPE project_status AS ENUM ('active', 'completed', 'archived');

CREATE TYPE deliverable_kind AS ENUM ('essay', 'problem_set', 'presentation', 'code', 'exam', 'other');
CREATE TYPE deliverable_status AS ENUM ('pending', 'in_progress', 'review_ready', 'approved', 'submitted', 'archived');

CREATE TYPE artifact_kind AS ENUM ('google_doc', 'google_sheet', 'google_slides', 'file', 'text', 'other');
CREATE TYPE artifact_status AS ENUM ('draft', 'review_ready', 'approved', 'submitted', 'archived');

CREATE TYPE admin_kind AS ENUM ('email', 'scheduling', 'form', 'payment', 'other');
CREATE TYPE admin_status AS ENUM ('open', 'in_progress', 'done', 'dismissed');

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest on every UPDATE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- courses (root of the world state)
-- ---------------------------------------------------------------------------
CREATE TABLE courses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  code         text,
  term         text,
  status       course_status NOT NULL DEFAULT 'active',
  -- provenance
  source       provider NOT NULL DEFAULT 'manual',
  source_id    text,
  source_url   text,
  ingested_at  timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Storage-level dedup: one row per external object.
CREATE UNIQUE INDEX courses_source_uq ON courses (source, source_id) WHERE source_id IS NOT NULL;
CREATE TRIGGER courses_set_updated BEFORE UPDATE ON courses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- people
-- ---------------------------------------------------------------------------
CREATE TABLE people (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    text NOT NULL,
  email        text,
  role         person_role NOT NULL DEFAULT 'other',
  course_id    uuid REFERENCES courses (id) ON DELETE SET NULL,
  source       provider NOT NULL DEFAULT 'manual',
  source_id    text,
  source_url   text,
  ingested_at  timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX people_source_uq ON people (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX people_course_idx ON people (course_id);
CREATE TRIGGER people_set_updated BEFORE UPDATE ON people FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions (a lecture / section / meeting occurrence)
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       uuid REFERENCES courses (id) ON DELETE CASCADE,
  title           text,
  kind            session_kind NOT NULL DEFAULT 'lecture',
  status          session_status NOT NULL DEFAULT 'scheduled',
  starts_at       timestamptz,
  ends_at         timestamptz,
  source_timezone text,
  source          provider NOT NULL DEFAULT 'manual',
  source_id       text,
  source_url      text,
  ingested_at     timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_source_uq ON sessions (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX sessions_course_idx ON sessions (course_id);
CREATE TRIGGER sessions_set_updated BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- assignments (canonical academic object, typically from Canvas)
-- ---------------------------------------------------------------------------
CREATE TABLE assignments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id            uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  title                text NOT NULL,
  description          text,
  status               assignment_status NOT NULL DEFAULT 'not_started',
  -- The instant is absolute; the source timezone is preserved separately so
  -- PR 6 can reason about it independently of the device timezone.
  due_at               timestamptz,
  due_source_timezone  text,
  points_possible      numeric,
  source               provider NOT NULL DEFAULT 'manual',
  source_id            text,
  source_url           text,
  ingested_at          timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX assignments_source_uq ON assignments (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX assignments_course_idx ON assignments (course_id);
CREATE TRIGGER assignments_set_updated BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid REFERENCES courses (id) ON DELETE CASCADE,
  title        text NOT NULL,
  status       project_status NOT NULL DEFAULT 'active',
  source       provider NOT NULL DEFAULT 'manual',
  source_id    text,
  source_url   text,
  ingested_at  timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_source_uq ON projects (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX projects_course_idx ON projects (course_id);
CREATE TRIGGER projects_set_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- deliverables (a concrete thing to produce; belongs to EXACTLY ONE of an
-- assignment or a project)
-- ---------------------------------------------------------------------------
CREATE TABLE deliverables (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A deliverable belongs to EXACTLY ONE parent (assignment or project); its
  -- course is derived through that parent, so no denormalized course_id here.
  assignment_id        uuid REFERENCES assignments (id) ON DELETE CASCADE,
  project_id           uuid REFERENCES projects (id) ON DELETE CASCADE,
  title                text NOT NULL,
  kind                 deliverable_kind NOT NULL DEFAULT 'other',
  status               deliverable_status NOT NULL DEFAULT 'pending',
  due_at               timestamptz,
  due_source_timezone  text,
  source               provider NOT NULL DEFAULT 'manual',
  source_id            text,
  source_url           text,
  ingested_at          timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliverables_one_parent CHECK (num_nonnulls(assignment_id, project_id) = 1)
);
CREATE UNIQUE INDEX deliverables_source_uq ON deliverables (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX deliverables_assignment_idx ON deliverables (assignment_id);
CREATE INDEX deliverables_project_idx ON deliverables (project_id);
CREATE TRIGGER deliverables_set_updated BEFORE UPDATE ON deliverables FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- artifacts (a produced, versioned document for a deliverable)
-- ---------------------------------------------------------------------------
CREATE TABLE artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id  uuid NOT NULL REFERENCES deliverables (id) ON DELETE CASCADE,
  kind            artifact_kind NOT NULL DEFAULT 'text',
  status          artifact_status NOT NULL DEFAULT 'draft',
  uri             text,
  remote_version  text,
  version         integer NOT NULL DEFAULT 1,
  source          provider NOT NULL DEFAULT 'manual',
  source_id       text,
  source_url      text,
  ingested_at     timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_version_positive CHECK (version >= 1)
);
CREATE UNIQUE INDEX artifacts_source_uq ON artifacts (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX artifacts_deliverable_idx ON artifacts (deliverable_id);
CREATE TRIGGER artifacts_set_updated BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- admin_items (administrative work: email, scheduling, forms)
-- ---------------------------------------------------------------------------
CREATE TABLE admin_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id            uuid REFERENCES courses (id) ON DELETE SET NULL,
  person_id            uuid REFERENCES people (id) ON DELETE SET NULL,
  kind                 admin_kind NOT NULL DEFAULT 'other',
  status               admin_status NOT NULL DEFAULT 'open',
  title                text NOT NULL,
  due_at               timestamptz,
  due_source_timezone  text,
  source               provider NOT NULL DEFAULT 'manual',
  source_id            text,
  source_url           text,
  ingested_at          timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_items_source_uq ON admin_items (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX admin_items_course_idx ON admin_items (course_id);
CREATE TRIGGER admin_items_set_updated BEFORE UPDATE ON admin_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- events (a fact that happened). Immutable: no updated_at. The idempotency
-- key + replay-safe processing columns are added by PR 2.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  subject_type  text,
  subject_id    uuid,
  source        provider NOT NULL DEFAULT 'system',
  source_id     text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_type_idx ON events (type);
CREATE INDEX events_subject_idx ON events (subject_type, subject_id);
CREATE INDEX events_occurred_idx ON events (occurred_at);
