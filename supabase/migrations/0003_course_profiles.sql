-- 0003_course_profiles
-- Derived, regenerable onboarding artifact per course. Kept in a SEPARATE table
-- (not on the canonical `courses` row) so synthesized/derived context never
-- pollutes or overwrites canonical Canvas data. One profile per course.

CREATE TABLE course_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid NOT NULL UNIQUE REFERENCES courses (id) ON DELETE CASCADE,
  profile           jsonb NOT NULL DEFAULT '{}'::jsonb,
  planning_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER course_profiles_set_updated
  BEFORE UPDATE ON course_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
