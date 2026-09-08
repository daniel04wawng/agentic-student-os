-- 0012_writing
-- Writing samples for contextual style. Samples carry a source, optional
-- course/professor/deliverable-kind scoping, deterministic style `features`, and
-- a `weight`. Edit-derived signals are stored as low-weight 'self' samples so a
-- single edit cannot dominate the learned style (no global over-learning).

CREATE TYPE writing_sample_source AS ENUM ('self', 'instructor', 'exemplar');

CREATE TABLE writing_samples (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           writing_sample_source NOT NULL,
  course_id        uuid REFERENCES courses (id) ON DELETE CASCADE,
  person_id        uuid REFERENCES people (id) ON DELETE SET NULL,
  deliverable_kind text,
  text             text NOT NULL,
  features         jsonb NOT NULL DEFAULT '{}'::jsonb,
  weight           numeric NOT NULL DEFAULT 1,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX writing_samples_course_idx ON writing_samples (course_id);
