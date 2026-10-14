--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgboss; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA pgboss;

--
-- Name: job_state; Type: TYPE; Schema: pgboss; Owner: postgres
--

CREATE TYPE pgboss.job_state AS ENUM (
    'created',
    'retry',
    'active',
    'completed',
    'cancelled',
    'failed'
);

--
-- Name: create_queue(text, jsonb); Type: FUNCTION; Schema: pgboss; Owner: postgres
--

CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $_$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO pgboss.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false)
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $_$;

--
-- Name: delete_queue(text); Type: FUNCTION; Schema: pgboss; Owner: postgres
--

CREATE FUNCTION pgboss.delete_queue(queue_name text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$;

--
-- Name: job_table_format(text, text); Type: FUNCTION; Schema: pgboss; Owner: postgres
--

CREATE FUNCTION pgboss.job_table_format(command text, table_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $_$;

--
-- Name: job_table_run(text, text, text); Type: FUNCTION; Schema: pgboss; Owner: postgres
--

CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$;

--
-- Name: job_table_run_async(text, integer, text, text, text); Type: FUNCTION; Schema: pgboss; Owner: postgres
--

CREATE FUNCTION pgboss.job_table_run_async(command_name text, version integer, command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$;

--
-- Name: acl_grants_bump_version(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.acl_grants_bump_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
        ON CONFLICT (only_row) DO UPDATE SET v = acl_grants_version.v + 1;
        RETURN NULL;
      END
      $$;

--
-- Name: entry_search_text(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.entry_search_text(payload text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
        DECLARE j json;
        BEGIN
          j := replace(payload, '\u0000', '')::json;
          RETURN CASE WHEN json_typeof(j -> 'text') = 'string' THEN j ->> 'text'
                      WHEN json_typeof(j) = 'string' THEN j #>> '{}'
                      ELSE NULL END;
        EXCEPTION WHEN others THEN RETURN NULL;
        END $$;

--
-- Name: safe_json(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.safe_json(t text) RETURNS json
    LANGUAGE plpgsql IMMUTABLE
    AS $$
        BEGIN RETURN t::json; EXCEPTION WHEN others THEN RETURN NULL; END $$;

--
-- Name: session_artifact_ids(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.session_artifact_ids(t text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
      DECLARE body json;
      BEGIN
        body := safe_json(replace(t, '\u0000', ''));
        IF json_typeof(body->'attachments') = 'array' THEN
          RETURN ARRAY(SELECT a->>'artifactId' FROM json_array_elements(body->'attachments') a
                       WHERE json_typeof(a->'artifactId') = 'string');
        END IF;
        IF body IS NOT NULL THEN RETURN ARRAY[]::text[]; END IF;
        RETURN ARRAY(SELECT m[1] FROM regexp_matches(t, '[0-9a-f]{32}', 'g') m);
      EXCEPTION WHEN others THEN
        RETURN ARRAY(SELECT m[1] FROM regexp_matches(t, '[0-9a-f]{32}', 'g') m);
      END $$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bam; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.bam (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    queue text,
    table_name text NOT NULL,
    command text NOT NULL,
    error text,
    created_on timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone
);

--
-- Name: job; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state NOT NULL,
    retry_limit integer DEFAULT 2 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    retry_delay integer DEFAULT 0 NOT NULL,
    retry_backoff boolean DEFAULT false NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 NOT NULL,
    deletion_seconds integer DEFAULT 604800 NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false NOT NULL,
    blocking boolean DEFAULT false NOT NULL,
    pending_dependencies integer DEFAULT 0 NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer
)
PARTITION BY LIST (name);

--
-- Name: job_common; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.job_common (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state NOT NULL,
    retry_limit integer DEFAULT 2 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    retry_delay integer DEFAULT 0 NOT NULL,
    retry_backoff boolean DEFAULT false NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 NOT NULL,
    deletion_seconds integer DEFAULT 604800 NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false NOT NULL,
    blocking boolean DEFAULT false NOT NULL,
    pending_dependencies integer DEFAULT 0 NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer,
    CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK ((NOT ((policy = 'key_strict_fifo'::text) AND (singleton_key IS NULL))))
);

--
-- Name: job_dependency; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.job_dependency (
    child_name text NOT NULL,
    child_id uuid NOT NULL,
    parent_name text NOT NULL,
    parent_id uuid NOT NULL
);

--
-- Name: queue; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.queue (
    name text NOT NULL,
    policy text NOT NULL,
    retry_limit integer NOT NULL,
    retry_delay integer NOT NULL,
    retry_backoff boolean NOT NULL,
    retry_delay_max integer,
    expire_seconds integer NOT NULL,
    retention_seconds integer NOT NULL,
    deletion_seconds integer NOT NULL,
    dead_letter text,
    partition boolean NOT NULL,
    table_name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    warning_queued integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    ready_history integer[] DEFAULT '{}'::integer[] NOT NULL,
    heartbeat_seconds integer,
    notify boolean DEFAULT false NOT NULL,
    singletons_active text[],
    monitor_on timestamp with time zone,
    maintain_on timestamp with time zone,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queue_check CHECK ((dead_letter IS DISTINCT FROM name))
);

--
-- Name: queue_stats; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.queue_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    captured_on timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (captured_on);

--
-- Name: queue_stats_20260822; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.queue_stats_20260822 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    captured_on timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: queue_stats_20260823; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.queue_stats_20260823 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    captured_on timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: schedule; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.schedule (
    name text NOT NULL,
    key text DEFAULT ''::text NOT NULL,
    cron text NOT NULL,
    timezone text,
    data jsonb,
    options jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: subscription; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.subscription (
    event text NOT NULL,
    name text NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: version; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.version (
    version integer NOT NULL,
    cron_on timestamp with time zone,
    bam_on timestamp with time zone,
    flow_on timestamp with time zone
);

--
-- Name: warning; Type: TABLE; Schema: pgboss; Owner: postgres
--

CREATE TABLE pgboss.warning (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    data jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ack_emoji; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ack_emoji (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: ack_emoji_picks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ack_emoji_picks (
    id bigint NOT NULL,
    org_id text NOT NULL,
    surface text NOT NULL,
    channel text NOT NULL,
    ts text NOT NULL,
    outcome text NOT NULL,
    picked text,
    icon text,
    message text,
    candidates text,
    model text,
    latency_ms integer,
    created_at bigint NOT NULL
);

--
-- Name: ack_emoji_picks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ack_emoji_picks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: ack_emoji_picks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ack_emoji_picks_id_seq OWNED BY public.ack_emoji_picks.id;

--
-- Name: acl_grants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.acl_grants (
    owner_scope_id text NOT NULL,
    path text NOT NULL,
    grantee_scope_id text NOT NULL,
    permission text NOT NULL,
    granted_by text NOT NULL,
    source_run_id text
);

--
-- Name: acl_grants_version; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.acl_grants_version (
    only_row boolean DEFAULT true NOT NULL,
    v bigint NOT NULL,
    CONSTRAINT acl_grants_version_only_row_check CHECK (only_row)
);

--
-- Name: admin_grants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.admin_grants (
    principal_id text NOT NULL,
    scope_id text NOT NULL,
    role text NOT NULL,
    granted_by text,
    created_at bigint
);

--
-- Name: adoption_roster_versions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_roster_versions (
    org text NOT NULL,
    revision integer NOT NULL,
    actor text NOT NULL,
    source text NOT NULL,
    recorded_at bigint NOT NULL,
    members jsonb NOT NULL
);

--
-- Name: adoption_run_facts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_run_facts (
    org text NOT NULL,
    run_id text NOT NULL,
    principal text,
    origin text NOT NULL,
    created_at bigint NOT NULL,
    status text NOT NULL,
    succeeded boolean NOT NULL,
    checked_at bigint NOT NULL,
    projection_version integer DEFAULT 1 NOT NULL
);

--
-- Name: adoption_scenario_budget; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_scenario_budget (
    org text NOT NULL,
    day bigint NOT NULL,
    model_calls integer NOT NULL,
    input_chars bigint DEFAULT 0 NOT NULL,
    call_limit integer DEFAULT 1000 NOT NULL,
    CONSTRAINT adoption_scenario_budget_call_limit_check CHECK (((call_limit >= 1000) AND (call_limit <= 1500))),
    CONSTRAINT adoption_scenario_budget_calls_within_limit_check CHECK (((model_calls >= 0) AND (model_calls <= call_limit))),
    CONSTRAINT adoption_scenario_budget_input_chars_check CHECK ((input_chars >= 0))
);

--
-- Name: adoption_scenario_control; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_scenario_control (
    org text NOT NULL,
    lease_token text NOT NULL,
    lease_until bigint NOT NULL,
    next_at bigint NOT NULL,
    dispatch_slot integer DEFAULT 0 NOT NULL,
    CONSTRAINT adoption_scenario_control_dispatch_slot_check CHECK (((dispatch_slot >= 0) AND (dispatch_slot <= 3)))
);

--
-- Name: adoption_scenario_jobs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_scenario_jobs (
    org text NOT NULL,
    run_id text NOT NULL,
    taxonomy_version text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at bigint NOT NULL,
    lease_token text,
    lease_until bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT adoption_scenario_jobs_attempts_check CHECK (((attempts >= 0) AND (attempts <= 3))),
    CONSTRAINT adoption_scenario_jobs_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text])))
);

--
-- Name: adoption_scenario_labels; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_scenario_labels (
    org text NOT NULL,
    run_id text NOT NULL,
    taxonomy_version text NOT NULL,
    classifier_version text NOT NULL,
    category text,
    status text NOT NULL,
    source text NOT NULL,
    processed_at bigint NOT NULL,
    CONSTRAINT adoption_scenario_labels_category_check CHECK ((category = ANY (ARRAY['research'::text, 'writing'::text, 'business'::text, 'data'::text, 'presentation'::text, 'media'::text, 'engineering'::text, 'coordination'::text]))),
    CONSTRAINT adoption_scenario_labels_check CHECK (((status = 'classified'::text) = (category IS NOT NULL))),
    CONSTRAINT adoption_scenario_labels_source_check CHECK ((source = ANY (ARRAY['rule'::text, 'model'::text, 'none'::text, 'manual'::text])))
);

--
-- Name: adoption_source_binding; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_source_binding (
    singleton boolean DEFAULT true NOT NULL,
    org text NOT NULL,
    CONSTRAINT adoption_source_binding_singleton_check CHECK (singleton)
);

--
-- Name: adoption_sync_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.adoption_sync_state (
    org text NOT NULL,
    checked_at bigint NOT NULL
);

--
-- Name: ambient_judgments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ambient_judgments (
    id bigint NOT NULL,
    org_id text NOT NULL,
    surface text NOT NULL,
    container text NOT NULL,
    decision text NOT NULL,
    reason text,
    asked_by text,
    prompt text,
    model text,
    latency_ms integer,
    ts_from text,
    ts_to text,
    created_at bigint NOT NULL
);

--
-- Name: ambient_judgments_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.ambient_judgments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: ambient_judgments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.ambient_judgments_id_seq OWNED BY public.ambient_judgments.id;

--
-- Name: announcement_dismissals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.announcement_dismissals (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: announcements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.announcements (
    id text NOT NULL,
    org_id text NOT NULL,
    level text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    starts_at bigint NOT NULL,
    ends_at bigint,
    created_by text NOT NULL,
    created_at bigint NOT NULL,
    popup boolean DEFAULT false NOT NULL
);

--
-- Name: approval_grant_modes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.approval_grant_modes (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: approval_grants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.approval_grants (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: approvals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.approvals (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: approved_harness_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.approved_harness_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    at bigint NOT NULL,
    principal_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    scope_label text NOT NULL,
    status text,
    detail text,
    idempotency_key text
);

--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;

--
-- Name: base_model_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.base_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: branding_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.branding_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: browse_max_steps_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.browse_max_steps_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: browse_model_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.browse_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: budget_spend; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.budget_spend (
    id bigint NOT NULL,
    principal_id text NOT NULL,
    at bigint NOT NULL,
    usd double precision NOT NULL
);

--
-- Name: budget_spend_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.budget_spend_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: budget_spend_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.budget_spend_id_seq OWNED BY public.budget_spend.id;

--
-- Name: channel_files; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channel_files (
    org_id text NOT NULL,
    container text NOT NULL,
    ts text NOT NULL,
    file_id text NOT NULL,
    name text,
    mimetype text,
    created_at bigint NOT NULL
);

--
-- Name: channel_header_pin_flag; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channel_header_pin_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: channel_messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channel_messages (
    org_id text NOT NULL,
    container text NOT NULL,
    ts text NOT NULL,
    sub text,
    author_id text,
    author_name text,
    text text DEFAULT ''::text NOT NULL,
    mentions jsonb,
    self boolean DEFAULT false NOT NULL,
    bot boolean DEFAULT false NOT NULL,
    mentions_self boolean DEFAULT false NOT NULL,
    edited_at bigint,
    deleted boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    handled boolean DEFAULT false NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(text, ''::text))) STORED
);

--
-- Name: channel_policy; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channel_policy (
    org_id text NOT NULL,
    container text NOT NULL,
    orders text DEFAULT ''::text NOT NULL,
    bots jsonb DEFAULT '{}'::jsonb NOT NULL,
    set_by text,
    updated_at bigint NOT NULL,
    ambient_enabled boolean
);

--
-- Name: channel_policy_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channel_policy_history (
    id bigint NOT NULL,
    org_id text NOT NULL,
    container text NOT NULL,
    orders text NOT NULL,
    set_by text,
    session_id text,
    created_at bigint NOT NULL,
    bots jsonb,
    ambient_enabled boolean
);

--
-- Name: channel_policy_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.channel_policy_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: channel_policy_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.channel_policy_history_id_seq OWNED BY public.channel_policy_history.id;

--
-- Name: channel_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.channel_state (
    org_id text NOT NULL,
    container text NOT NULL,
    last_ts text,
    oldest_ts text,
    name text,
    kind text,
    members jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: command_policies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.command_policies (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: connector_clients; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.connector_clients (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: connector_status; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.connector_status (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: context_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.context_requests (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: coworker_diagram_releases; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.coworker_diagram_releases (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: coworker_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.coworker_migrations (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: coworker_tinyfish_releases; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.coworker_tinyfish_releases (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: credential_liveness; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.credential_liveness (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: credential_usage; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.credential_usage (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    slug text NOT NULL,
    host text NOT NULL,
    status text NOT NULL,
    upstream_status integer,
    scope_label text NOT NULL,
    principal_id text NOT NULL
);

--
-- Name: credential_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.credential_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: credential_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.credential_usage_id_seq OWNED BY public.credential_usage.id;

--
-- Name: cron_fire_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.cron_fire_log (
    cron_id text NOT NULL,
    fire_key text NOT NULL,
    fired_at bigint NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: cron_fire_log_reads; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.cron_fire_log_reads (
    cron_id text NOT NULL,
    fire_key text NOT NULL,
    viewer_id text NOT NULL,
    read_at bigint NOT NULL,
    fire_digest text
);

--
-- Name: cron_mail_bridge_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.cron_mail_bridge_state (
    fire_key text NOT NULL,
    fired_at bigint NOT NULL,
    mailed_at bigint NOT NULL
);

--
-- Name: crons; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.crons (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: custom_model_providers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.custom_model_providers (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: deactivated_principals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.deactivated_principals (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.deliveries (
    id text NOT NULL,
    idempotency_key text NOT NULL,
    destination jsonb NOT NULL,
    text text NOT NULL,
    created_at bigint NOT NULL,
    delivered_at bigint,
    attachments jsonb,
    provenance jsonb,
    recipient_thread_ref text,
    shadow boolean DEFAULT false NOT NULL,
    deliver_latency_ms integer,
    slack_api_ms integer,
    claim_expires_at bigint
);

--
-- Name: deploy_git_repos; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.deploy_git_repos (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: deployment_identity; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.deployment_identity (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: deployment_layer; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.deployment_layer (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: deployments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.deployments (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: directory_channel_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.directory_channel_members (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    principal_id text NOT NULL
);

--
-- Name: directory_channels; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.directory_channels (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    name text NOT NULL,
    name_lc text NOT NULL,
    is_private boolean DEFAULT false NOT NULL,
    is_external boolean DEFAULT false NOT NULL,
    roster_known boolean DEFAULT false NOT NULL
);

--
-- Name: directory_group_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.directory_group_members (
    org_id text NOT NULL,
    group_id text NOT NULL,
    principal_id text NOT NULL
);

--
-- Name: directory_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.directory_groups (
    org_id text NOT NULL,
    group_id text NOT NULL,
    roster_known boolean DEFAULT false NOT NULL
);

--
-- Name: directory_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.directory_members (
    org_id text NOT NULL,
    principal_id text NOT NULL,
    display_name text NOT NULL,
    display_name_lc text NOT NULL,
    type text NOT NULL,
    slack_id text
);

--
-- Name: directory_meta; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.directory_meta (
    org_id text NOT NULL,
    workspace_url text,
    updated_at bigint NOT NULL
);

--
-- Name: directory_sync; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.directory_sync (
    org_id text NOT NULL,
    members_hash text,
    channels_hash text,
    groups_hash text,
    channel_members_synced boolean DEFAULT false NOT NULL,
    updated_at bigint NOT NULL,
    members_synced_at bigint,
    channels_synced_at bigint,
    groups_synced_at bigint
);

--
-- Name: durable_map_versions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.durable_map_versions (
    tbl text NOT NULL,
    v bigint NOT NULL
);

--
-- Name: egress_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.egress_events (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    source text NOT NULL,
    host text NOT NULL,
    allowed boolean NOT NULL,
    scope_label text NOT NULL,
    port integer,
    verdict text,
    via text,
    peer_ip text,
    principal_id text
);

--
-- Name: egress_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.egress_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: egress_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.egress_events_id_seq OWNED BY public.egress_events.id;

--
-- Name: egress_policies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.egress_policies (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: environment_attachments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.environment_attachments (
    scope_id text NOT NULL,
    environment_id text NOT NULL,
    attached_by text NOT NULL,
    attached_at bigint NOT NULL
);

--
-- Name: environments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.environments (
    id text NOT NULL,
    org_id text NOT NULL,
    name text,
    owner_actor_id text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

--
-- Name: error_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.error_events (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    scope_label text NOT NULL,
    category text NOT NULL,
    code text NOT NULL,
    message text NOT NULL,
    session_id text
);

--
-- Name: error_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.error_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: error_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.error_events_id_seq OWNED BY public.error_events.id;

--
-- Name: external_slack_participants_flag; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.external_slack_participants_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: file_artifacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.file_artifacts (
    id text NOT NULL,
    kind text DEFAULT 'file'::text NOT NULL,
    owner_scope_id text NOT NULL,
    path text NOT NULL,
    name text NOT NULL,
    mimetype text NOT NULL,
    size_bytes bigint NOT NULL,
    blob_key text,
    sha256 text,
    direction text NOT NULL,
    created_by text NOT NULL,
    created_in_scope text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    source text DEFAULT 'live'::text NOT NULL
);

--
-- Name: idempotency; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.idempotency (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: inbound_artifact_cleanup; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.inbound_artifact_cleanup (
    artifact_id text NOT NULL,
    run_id text NOT NULL,
    created_at bigint NOT NULL,
    next_attempt_at bigint DEFAULT 0 NOT NULL
);

--
-- Name: instance_heartbeats; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.instance_heartbeats (
    instance_id text NOT NULL,
    build_sha text NOT NULL,
    started_at bigint NOT NULL,
    beat_at timestamp with time zone NOT NULL
);

--
-- Name: interactive_fast_mode_flag; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.interactive_fast_mode_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: keychain_asks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.keychain_asks (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: keychain_credentials; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.keychain_credentials (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: keychain_grants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.keychain_grants (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: legacy_turn_intents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.legacy_turn_intents (
    id text NOT NULL,
    principal_id text NOT NULL,
    scope_id text NOT NULL,
    thread_ref text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL
);

--
-- Name: llm_prompt_envelopes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.llm_prompt_envelopes (
    hash text NOT NULL,
    body text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: login_passwords; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.login_passwords (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: mcp_servers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.mcp_servers (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: memory_revisions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.memory_revisions (
    id bigint NOT NULL,
    scope_id text NOT NULL,
    seq bigint NOT NULL,
    op text NOT NULL,
    body text NOT NULL,
    author text,
    at bigint NOT NULL
);

--
-- Name: memory_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.memory_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: memory_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.memory_revisions_id_seq OWNED BY public.memory_revisions.id;

--
-- Name: model_credentials; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.model_credentials (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: monitors; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.monitors (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: notification_reads; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notification_reads (
    principal_id text NOT NULL,
    event_id text NOT NULL,
    session_id text NOT NULL,
    read_at bigint NOT NULL
);

--
-- Name: notification_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notification_state (
    id integer NOT NULL,
    activated_at bigint NOT NULL,
    CONSTRAINT notification_state_id_check CHECK ((id = 1))
);

--
-- Name: org_ambient_flag; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.org_ambient_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: participants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.participants (
    session_id text NOT NULL,
    principal_id text NOT NULL,
    valid_from bigint NOT NULL,
    valid_to bigint,
    valid_from_seq integer,
    valid_to_seq integer,
    title text,
    archived boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    color text
);

--
-- Name: people_directory_urls; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.people_directory_urls (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: process_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.process_sessions (
    process_id text NOT NULL,
    scope_id text NOT NULL,
    kind text NOT NULL,
    command text NOT NULL,
    started_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    status text NOT NULL,
    session_ref text,
    run_id text
);

--
-- Name: project_boards; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.project_boards (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: project_preferences; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.project_preferences (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: projects; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projects (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: qm_cn_title_localizations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.qm_cn_title_localizations (
    batch_id text NOT NULL,
    row_index integer NOT NULL,
    record jsonb NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    reverted_at timestamp with time zone
);

--
-- Name: rate_limit_windows; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.rate_limit_windows (
    principal_id text NOT NULL,
    window_start bigint NOT NULL,
    count integer NOT NULL
);

--
-- Name: run_activity; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.run_activity (
    id bigint NOT NULL,
    run_id text NOT NULL,
    seq bigint NOT NULL,
    parent_seq bigint,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: run_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.run_activity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: run_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.run_activity_id_seq OWNED BY public.run_activity.id;

--
-- Name: run_signals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.run_signals (
    id bigint NOT NULL,
    run_id text NOT NULL,
    kind text NOT NULL,
    text text,
    payload jsonb,
    created_at bigint NOT NULL,
    consumed_at bigint
);

--
-- Name: run_signals_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.run_signals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: run_signals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.run_signals_id_seq OWNED BY public.run_signals.id;

--
-- Name: runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.runs (
    id text NOT NULL,
    session_id text NOT NULL,
    status text NOT NULL,
    request text NOT NULL,
    result text,
    idempotency_key text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    lease_token text,
    lease_expires_at bigint,
    worker_id text,
    created_at bigint NOT NULL,
    started_at bigint,
    finished_at bigint,
    delivery_state text,
    error_attempts integer DEFAULT 0 NOT NULL,
    seq bigint NOT NULL
);

--
-- Name: runs_seq_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.runs_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: runs_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.runs_seq_seq OWNED BY public.runs.seq;

--
-- Name: sandbox_routing; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sandbox_routing (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.schema_migrations (
    id text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: secret_drops; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.secret_drops (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: security_postures; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.security_postures (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: session_entries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session_entries (
    session_id text NOT NULL,
    seq integer NOT NULL,
    parent_seq integer,
    type text NOT NULL,
    payload text,
    scope_label text NOT NULL,
    created_at bigint NOT NULL,
    search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(public.entry_search_text(payload), ''::text))) STORED
);

--
-- Name: session_leases; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session_leases (
    session_id text NOT NULL,
    token text NOT NULL,
    expires_at bigint NOT NULL,
    holder text,
    acquired_at bigint
);

--
-- Name: session_llm_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session_llm_requests (
    id text NOT NULL,
    session_id text NOT NULL,
    turn_seq integer,
    step integer NOT NULL,
    model text NOT NULL,
    scope_label text NOT NULL,
    request text,
    truncated boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    ttft_ms integer,
    duration_ms integer,
    step_gap_ms integer,
    tool_wall_json text,
    usage_json text,
    transport_json text,
    gap_phases_json text,
    prompt_hash text
);

--
-- Name: session_tape; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.session_tape (
    session_id text NOT NULL,
    seq integer NOT NULL,
    kind text NOT NULL,
    harness text,
    payload text NOT NULL,
    scope_label text NOT NULL,
    bare_text text,
    ts text,
    change_time text,
    hidden boolean,
    overheard boolean,
    author text,
    entry_seq integer,
    covers_entry_seq integer,
    created_at bigint NOT NULL
);

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    type text NOT NULL,
    scope_id text NOT NULL,
    thread_ref text NOT NULL,
    created_at bigint NOT NULL,
    title text,
    channel_name text,
    surface text,
    last_activity bigint,
    messages integer,
    turns integer,
    forked_from_session_id text,
    forked_from_title text,
    fork_boundary_seq integer
);

--
-- Name: skill_bundles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.skill_bundles (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: skill_packs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.skill_packs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: skills; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.skills (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: slack_installation; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.slack_installation (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: soul_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.soul_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: soul_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.soul_history (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: source_auth_replay; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.source_auth_replay (
    event_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

--
-- Name: surface_active_threads; Type: MATERIALIZED VIEW; Schema: public; Owner: postgres
--

CREATE MATERIALIZED VIEW public.surface_active_threads AS
 SELECT org_id,
    container,
    sub,
    max(ts) AS last_ts,
    count(*) AS message_count,
    max(created_at) AS last_activity_at
   FROM public.channel_messages
  WHERE ((sub IS NOT NULL) AND (deleted = false))
  GROUP BY org_id, container, sub
  WITH NO DATA;

--
-- Name: task_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.task_events (
    id bigint NOT NULL,
    task_id text NOT NULL,
    run_id text NOT NULL,
    type text NOT NULL,
    from_status text,
    to_status text NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT task_events_type_check CHECK ((type = ANY (ARRAY['created'::text, 'status_changed'::text])))
);

--
-- Name: task_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.task_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: task_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.task_events_id_seq OWNED BY public.task_events.id;

--
-- Name: tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tasks (
    id text NOT NULL,
    session_id text NOT NULL,
    origin_run_id text NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text, 'failed'::text])))
);

--
-- Name: tool_calls; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tool_calls (
    run_id text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    call_index integer NOT NULL,
    output text NOT NULL,
    created_at bigint NOT NULL
);

--
-- Name: turn_metrics; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.turn_metrics (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    scope_label text NOT NULL,
    session_id text,
    turn_seq integer,
    run_id text,
    status text NOT NULL,
    total_ms integer NOT NULL,
    ttft_ms integer,
    intake_preamble_ms integer,
    dispatch_ms integer,
    provisioned boolean,
    cold_start boolean,
    model_calls integer,
    tool_calls integer,
    provision_ms integer,
    materialize_ms integer,
    creds_ms integer,
    layers_ms integer,
    compile_ms integer,
    recall_ms integer,
    exec_ms integer,
    stream_ms integer,
    lease_ms integer,
    capture_ms integer,
    ingress_ms integer,
    detect_ms integer,
    compact_ms integer,
    queue_ms integer,
    deliver_ms integer,
    slack_inflight_ms integer,
    resumed_from_seq integer,
    cache_read bigint,
    cache_write bigint,
    uncached_input bigint
);

--
-- Name: turn_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.turn_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: turn_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.turn_metrics_id_seq OWNED BY public.turn_metrics.id;

--
-- Name: turn_wall_clock_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.turn_wall_clock_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: unfulfilled_insights_flag; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.unfulfilled_insights_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: web_first_turns; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.web_first_turns (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: web_ui_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.web_ui_state (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: webhooks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.webhooks (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: webui_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.webui_events (
    at bigint NOT NULL,
    principal text NOT NULL,
    type text NOT NULL,
    ref text NOT NULL
);

--
-- Name: webui_growth_profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.webui_growth_profiles (
    principal text NOT NULL,
    state jsonb NOT NULL
);

--
-- Name: webui_growth_rewards; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.webui_growth_rewards (
    principal text NOT NULL,
    reward_key text NOT NULL,
    run_id text NOT NULL,
    points integer NOT NULL,
    reason text NOT NULL,
    at bigint NOT NULL,
    CONSTRAINT webui_growth_rewards_points_check CHECK ((points > 0))
);

--
-- Name: webui_home; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.webui_home (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: webui_model_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.webui_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

--
-- Name: job_common; Type: TABLE ATTACH; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;

--
-- Name: queue_stats_20260822; Type: TABLE ATTACH; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.queue_stats ATTACH PARTITION pgboss.queue_stats_20260822 FOR VALUES FROM ('2026-08-22 00:00:00+00') TO ('2026-08-23 00:00:00+00');

--
-- Name: queue_stats_20260823; Type: TABLE ATTACH; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.queue_stats ATTACH PARTITION pgboss.queue_stats_20260823 FOR VALUES FROM ('2026-08-23 00:00:00+00') TO ('2026-08-24 00:00:00+00');

--
-- Name: ack_emoji_picks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ack_emoji_picks ALTER COLUMN id SET DEFAULT nextval('public.ack_emoji_picks_id_seq'::regclass);

--
-- Name: ambient_judgments id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ambient_judgments ALTER COLUMN id SET DEFAULT nextval('public.ambient_judgments_id_seq'::regclass);

--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);

--
-- Name: budget_spend id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.budget_spend ALTER COLUMN id SET DEFAULT nextval('public.budget_spend_id_seq'::regclass);

--
-- Name: channel_policy_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channel_policy_history ALTER COLUMN id SET DEFAULT nextval('public.channel_policy_history_id_seq'::regclass);

--
-- Name: credential_usage id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.credential_usage ALTER COLUMN id SET DEFAULT nextval('public.credential_usage_id_seq'::regclass);

--
-- Name: egress_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.egress_events ALTER COLUMN id SET DEFAULT nextval('public.egress_events_id_seq'::regclass);

--
-- Name: error_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.error_events ALTER COLUMN id SET DEFAULT nextval('public.error_events_id_seq'::regclass);

--
-- Name: memory_revisions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_revisions ALTER COLUMN id SET DEFAULT nextval('public.memory_revisions_id_seq'::regclass);

--
-- Name: run_activity id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.run_activity ALTER COLUMN id SET DEFAULT nextval('public.run_activity_id_seq'::regclass);

--
-- Name: run_signals id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.run_signals ALTER COLUMN id SET DEFAULT nextval('public.run_signals_id_seq'::regclass);

--
-- Name: runs seq; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.runs ALTER COLUMN seq SET DEFAULT nextval('public.runs_seq_seq'::regclass);

--
-- Name: task_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_events ALTER COLUMN id SET DEFAULT nextval('public.task_events_id_seq'::regclass);

--
-- Name: turn_metrics id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.turn_metrics ALTER COLUMN id SET DEFAULT nextval('public.turn_metrics_id_seq'::regclass);

--
-- Name: bam bam_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.bam
    ADD CONSTRAINT bam_pkey PRIMARY KEY (id);

--
-- Name: job job_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.job
    ADD CONSTRAINT job_pkey PRIMARY KEY (name, id);

--
-- Name: job_common job_common_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT job_common_pkey PRIMARY KEY (name, id);

--
-- Name: job_dependency job_dependency_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.job_dependency
    ADD CONSTRAINT job_dependency_pkey PRIMARY KEY (child_name, child_id, parent_name, parent_id);

--
-- Name: queue queue_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_pkey PRIMARY KEY (name);

--
-- Name: queue_stats queue_stats_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.queue_stats
    ADD CONSTRAINT queue_stats_pkey PRIMARY KEY (id, captured_on);

--
-- Name: queue_stats_20260822 queue_stats_20260822_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.queue_stats_20260822
    ADD CONSTRAINT queue_stats_20260822_pkey PRIMARY KEY (id, captured_on);

--
-- Name: queue_stats_20260823 queue_stats_20260823_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.queue_stats_20260823
    ADD CONSTRAINT queue_stats_20260823_pkey PRIMARY KEY (id, captured_on);

--
-- Name: schedule schedule_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_pkey PRIMARY KEY (name, key);

--
-- Name: subscription subscription_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_pkey PRIMARY KEY (event, name);

--
-- Name: version version_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.version
    ADD CONSTRAINT version_pkey PRIMARY KEY (version);

--
-- Name: warning warning_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.warning
    ADD CONSTRAINT warning_pkey PRIMARY KEY (id);

--
-- Name: ack_emoji_picks ack_emoji_picks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ack_emoji_picks
    ADD CONSTRAINT ack_emoji_picks_pkey PRIMARY KEY (id);

--
-- Name: ack_emoji ack_emoji_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ack_emoji
    ADD CONSTRAINT ack_emoji_pkey PRIMARY KEY (id);

--
-- Name: acl_grants acl_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.acl_grants
    ADD CONSTRAINT acl_grants_pkey PRIMARY KEY (owner_scope_id, path, grantee_scope_id, permission);

--
-- Name: acl_grants_version acl_grants_version_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.acl_grants_version
    ADD CONSTRAINT acl_grants_version_pkey PRIMARY KEY (only_row);

--
-- Name: admin_grants admin_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.admin_grants
    ADD CONSTRAINT admin_grants_pkey PRIMARY KEY (principal_id, scope_id, role);

--
-- Name: adoption_roster_versions adoption_roster_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_roster_versions
    ADD CONSTRAINT adoption_roster_versions_pkey PRIMARY KEY (org, revision);

--
-- Name: adoption_run_facts adoption_run_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_run_facts
    ADD CONSTRAINT adoption_run_facts_pkey PRIMARY KEY (org, run_id);

--
-- Name: adoption_scenario_budget adoption_scenario_budget_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_scenario_budget
    ADD CONSTRAINT adoption_scenario_budget_pkey PRIMARY KEY (org, day);

--
-- Name: adoption_scenario_control adoption_scenario_control_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_scenario_control
    ADD CONSTRAINT adoption_scenario_control_pkey PRIMARY KEY (org);

--
-- Name: adoption_scenario_jobs adoption_scenario_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_scenario_jobs
    ADD CONSTRAINT adoption_scenario_jobs_pkey PRIMARY KEY (org, run_id, taxonomy_version);

--
-- Name: adoption_scenario_labels adoption_scenario_labels_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_scenario_labels
    ADD CONSTRAINT adoption_scenario_labels_pkey PRIMARY KEY (org, run_id, taxonomy_version);

--
-- Name: adoption_source_binding adoption_source_binding_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_source_binding
    ADD CONSTRAINT adoption_source_binding_pkey PRIMARY KEY (singleton);

--
-- Name: adoption_sync_state adoption_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.adoption_sync_state
    ADD CONSTRAINT adoption_sync_state_pkey PRIMARY KEY (org);

--
-- Name: ambient_judgments ambient_judgments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ambient_judgments
    ADD CONSTRAINT ambient_judgments_pkey PRIMARY KEY (id);

--
-- Name: announcement_dismissals announcement_dismissals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcement_dismissals
    ADD CONSTRAINT announcement_dismissals_pkey PRIMARY KEY (id);

--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

--
-- Name: approval_grant_modes approval_grant_modes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.approval_grant_modes
    ADD CONSTRAINT approval_grant_modes_pkey PRIMARY KEY (id);

--
-- Name: approval_grants approval_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.approval_grants
    ADD CONSTRAINT approval_grants_pkey PRIMARY KEY (id);

--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);

--
-- Name: approved_harness_configs approved_harness_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.approved_harness_configs
    ADD CONSTRAINT approved_harness_configs_pkey PRIMARY KEY (id);

--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

--
-- Name: base_model_configs base_model_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.base_model_configs
    ADD CONSTRAINT base_model_configs_pkey PRIMARY KEY (id);

--
-- Name: branding_configs branding_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.branding_configs
    ADD CONSTRAINT branding_configs_pkey PRIMARY KEY (id);

--
-- Name: browse_max_steps_configs browse_max_steps_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.browse_max_steps_configs
    ADD CONSTRAINT browse_max_steps_configs_pkey PRIMARY KEY (id);

--
-- Name: browse_model_configs browse_model_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.browse_model_configs
    ADD CONSTRAINT browse_model_configs_pkey PRIMARY KEY (id);

--
-- Name: budget_spend budget_spend_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.budget_spend
    ADD CONSTRAINT budget_spend_pkey PRIMARY KEY (id);

--
-- Name: channel_files channel_files_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channel_files
    ADD CONSTRAINT channel_files_pkey PRIMARY KEY (org_id, container, ts, file_id);

--
-- Name: channel_header_pin_flag channel_header_pin_flag_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channel_header_pin_flag
    ADD CONSTRAINT channel_header_pin_flag_pkey PRIMARY KEY (id);

--
-- Name: channel_messages channel_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channel_messages
    ADD CONSTRAINT channel_messages_pkey PRIMARY KEY (org_id, container, ts);

--
-- Name: channel_policy_history channel_policy_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channel_policy_history
    ADD CONSTRAINT channel_policy_history_pkey PRIMARY KEY (id);

--
-- Name: channel_policy channel_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channel_policy
    ADD CONSTRAINT channel_policy_pkey PRIMARY KEY (org_id, container);

--
-- Name: channel_state channel_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.channel_state
    ADD CONSTRAINT channel_state_pkey PRIMARY KEY (org_id, container);

--
-- Name: command_policies command_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.command_policies
    ADD CONSTRAINT command_policies_pkey PRIMARY KEY (id);

--
-- Name: connector_clients connector_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.connector_clients
    ADD CONSTRAINT connector_clients_pkey PRIMARY KEY (id);

--
-- Name: connector_status connector_status_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.connector_status
    ADD CONSTRAINT connector_status_pkey PRIMARY KEY (id);

--
-- Name: context_requests context_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.context_requests
    ADD CONSTRAINT context_requests_pkey PRIMARY KEY (id);

--
-- Name: coworker_diagram_releases coworker_diagram_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coworker_diagram_releases
    ADD CONSTRAINT coworker_diagram_releases_pkey PRIMARY KEY (id);

--
-- Name: coworker_migrations coworker_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coworker_migrations
    ADD CONSTRAINT coworker_migrations_pkey PRIMARY KEY (id);

--
-- Name: coworker_tinyfish_releases coworker_tinyfish_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coworker_tinyfish_releases
    ADD CONSTRAINT coworker_tinyfish_releases_pkey PRIMARY KEY (id);

--
-- Name: credential_liveness credential_liveness_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.credential_liveness
    ADD CONSTRAINT credential_liveness_pkey PRIMARY KEY (id);

--
-- Name: credential_usage credential_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.credential_usage
    ADD CONSTRAINT credential_usage_pkey PRIMARY KEY (id);

--
-- Name: cron_fire_log cron_fire_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.cron_fire_log
    ADD CONSTRAINT cron_fire_log_pkey PRIMARY KEY (cron_id, fire_key);

--
-- Name: cron_fire_log_reads cron_fire_log_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.cron_fire_log_reads
    ADD CONSTRAINT cron_fire_log_reads_pkey PRIMARY KEY (cron_id, fire_key, viewer_id);

--
-- Name: cron_mail_bridge_state cron_mail_bridge_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.cron_mail_bridge_state
    ADD CONSTRAINT cron_mail_bridge_state_pkey PRIMARY KEY (fire_key);

--
-- Name: crons crons_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.crons
    ADD CONSTRAINT crons_pkey PRIMARY KEY (id);

--
-- Name: custom_model_providers custom_model_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.custom_model_providers
    ADD CONSTRAINT custom_model_providers_pkey PRIMARY KEY (id);

--
-- Name: deactivated_principals deactivated_principals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deactivated_principals
    ADD CONSTRAINT deactivated_principals_pkey PRIMARY KEY (id);

--
-- Name: deliveries deliveries_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_idempotency_key_key UNIQUE (idempotency_key);

--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);

--
-- Name: deploy_git_repos deploy_git_repos_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deploy_git_repos
    ADD CONSTRAINT deploy_git_repos_pkey PRIMARY KEY (id);

--
-- Name: deployment_identity deployment_identity_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deployment_identity
    ADD CONSTRAINT deployment_identity_pkey PRIMARY KEY (id);

--
-- Name: deployment_layer deployment_layer_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deployment_layer
    ADD CONSTRAINT deployment_layer_pkey PRIMARY KEY (id);

--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);

--
-- Name: directory_channel_members directory_channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.directory_channel_members
    ADD CONSTRAINT directory_channel_members_pkey PRIMARY KEY (org_id, channel_id, principal_id);

--
-- Name: directory_channels directory_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.directory_channels
    ADD CONSTRAINT directory_channels_pkey PRIMARY KEY (org_id, channel_id);

--
-- Name: directory_group_members directory_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.directory_group_members
    ADD CONSTRAINT directory_group_members_pkey PRIMARY KEY (org_id, group_id, principal_id);

--
-- Name: directory_groups directory_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.directory_groups
    ADD CONSTRAINT directory_groups_pkey PRIMARY KEY (org_id, group_id);

--
-- Name: directory_members directory_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.directory_members
    ADD CONSTRAINT directory_members_pkey PRIMARY KEY (org_id, principal_id);

--
-- Name: directory_meta directory_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.directory_meta
    ADD CONSTRAINT directory_meta_pkey PRIMARY KEY (org_id);

--
-- Name: directory_sync directory_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.directory_sync
    ADD CONSTRAINT directory_sync_pkey PRIMARY KEY (org_id);

--
-- Name: durable_map_versions durable_map_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.durable_map_versions
    ADD CONSTRAINT durable_map_versions_pkey PRIMARY KEY (tbl);

--
-- Name: egress_events egress_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.egress_events
    ADD CONSTRAINT egress_events_pkey PRIMARY KEY (id);

--
-- Name: egress_policies egress_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.egress_policies
    ADD CONSTRAINT egress_policies_pkey PRIMARY KEY (id);

--
-- Name: environment_attachments environment_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.environment_attachments
    ADD CONSTRAINT environment_attachments_pkey PRIMARY KEY (scope_id);

--
-- Name: environments environments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);

--
-- Name: error_events error_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.error_events
    ADD CONSTRAINT error_events_pkey PRIMARY KEY (id);

--
-- Name: external_slack_participants_flag external_slack_participants_flag_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.external_slack_participants_flag
    ADD CONSTRAINT external_slack_participants_flag_pkey PRIMARY KEY (id);

--
-- Name: file_artifacts file_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.file_artifacts
    ADD CONSTRAINT file_artifacts_pkey PRIMARY KEY (id);

--
-- Name: idempotency idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.idempotency
    ADD CONSTRAINT idempotency_pkey PRIMARY KEY (id);

--
-- Name: inbound_artifact_cleanup inbound_artifact_cleanup_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inbound_artifact_cleanup
    ADD CONSTRAINT inbound_artifact_cleanup_pkey PRIMARY KEY (artifact_id);

--
-- Name: instance_heartbeats instance_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instance_heartbeats
    ADD CONSTRAINT instance_heartbeats_pkey PRIMARY KEY (instance_id);

--
-- Name: interactive_fast_mode_flag interactive_fast_mode_flag_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.interactive_fast_mode_flag
    ADD CONSTRAINT interactive_fast_mode_flag_pkey PRIMARY KEY (id);

--
-- Name: keychain_asks keychain_asks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.keychain_asks
    ADD CONSTRAINT keychain_asks_pkey PRIMARY KEY (id);

--
-- Name: keychain_credentials keychain_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.keychain_credentials
    ADD CONSTRAINT keychain_credentials_pkey PRIMARY KEY (id);

--
-- Name: keychain_grants keychain_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.keychain_grants
    ADD CONSTRAINT keychain_grants_pkey PRIMARY KEY (id);

--
-- Name: legacy_turn_intents legacy_turn_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.legacy_turn_intents
    ADD CONSTRAINT legacy_turn_intents_pkey PRIMARY KEY (id);

--
-- Name: llm_prompt_envelopes llm_prompt_envelopes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.llm_prompt_envelopes
    ADD CONSTRAINT llm_prompt_envelopes_pkey PRIMARY KEY (hash);

--
-- Name: login_passwords login_passwords_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.login_passwords
    ADD CONSTRAINT login_passwords_pkey PRIMARY KEY (id);

--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);

--
-- Name: memory_revisions memory_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_revisions
    ADD CONSTRAINT memory_revisions_pkey PRIMARY KEY (id);

--
-- Name: memory_revisions memory_revisions_scope_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_revisions
    ADD CONSTRAINT memory_revisions_scope_id_seq_key UNIQUE (scope_id, seq);

--
-- Name: model_credentials model_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.model_credentials
    ADD CONSTRAINT model_credentials_pkey PRIMARY KEY (id);

--
-- Name: monitors monitors_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.monitors
    ADD CONSTRAINT monitors_pkey PRIMARY KEY (id);

--
-- Name: notification_reads notification_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (principal_id, event_id);

--
-- Name: notification_state notification_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_state
    ADD CONSTRAINT notification_state_pkey PRIMARY KEY (id);

--
-- Name: org_ambient_flag org_ambient_flag_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.org_ambient_flag
    ADD CONSTRAINT org_ambient_flag_pkey PRIMARY KEY (id);

--
-- Name: participants participants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.participants
    ADD CONSTRAINT participants_pkey PRIMARY KEY (session_id, principal_id);

--
-- Name: people_directory_urls people_directory_urls_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.people_directory_urls
    ADD CONSTRAINT people_directory_urls_pkey PRIMARY KEY (id);

--
-- Name: process_sessions process_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.process_sessions
    ADD CONSTRAINT process_sessions_pkey PRIMARY KEY (process_id);

--
-- Name: project_boards project_boards_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.project_boards
    ADD CONSTRAINT project_boards_pkey PRIMARY KEY (id);

--
-- Name: project_preferences project_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.project_preferences
    ADD CONSTRAINT project_preferences_pkey PRIMARY KEY (id);

--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

--
-- Name: qm_cn_title_localizations qm_cn_title_localizations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.qm_cn_title_localizations
    ADD CONSTRAINT qm_cn_title_localizations_pkey PRIMARY KEY (batch_id, row_index);

--
-- Name: rate_limit_windows rate_limit_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rate_limit_windows
    ADD CONSTRAINT rate_limit_windows_pkey PRIMARY KEY (principal_id);

--
-- Name: run_activity run_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.run_activity
    ADD CONSTRAINT run_activity_pkey PRIMARY KEY (id);

--
-- Name: run_signals run_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.run_signals
    ADD CONSTRAINT run_signals_pkey PRIMARY KEY (id);

--
-- Name: runs runs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_idempotency_key_key UNIQUE (idempotency_key);

--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

--
-- Name: sandbox_routing sandbox_routing_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sandbox_routing
    ADD CONSTRAINT sandbox_routing_pkey PRIMARY KEY (id);

--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);

--
-- Name: secret_drops secret_drops_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.secret_drops
    ADD CONSTRAINT secret_drops_pkey PRIMARY KEY (id);

--
-- Name: security_postures security_postures_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.security_postures
    ADD CONSTRAINT security_postures_pkey PRIMARY KEY (id);

--
-- Name: session_entries session_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session_entries
    ADD CONSTRAINT session_entries_pkey PRIMARY KEY (session_id, seq);

--
-- Name: session_leases session_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session_leases
    ADD CONSTRAINT session_leases_pkey PRIMARY KEY (session_id);

--
-- Name: session_llm_requests session_llm_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session_llm_requests
    ADD CONSTRAINT session_llm_requests_pkey PRIMARY KEY (id);

--
-- Name: session_tape session_tape_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.session_tape
    ADD CONSTRAINT session_tape_pkey PRIMARY KEY (session_id, seq);

--
-- Name: sessions sessions_fork_provenance_pair; Type: CHECK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE public.sessions
    ADD CONSTRAINT sessions_fork_provenance_pair CHECK (((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL))) NOT VALID;

--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

--
-- Name: sessions sessions_thread_ref_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_thread_ref_key UNIQUE (thread_ref);

--
-- Name: skill_bundles skill_bundles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_pkey PRIMARY KEY (id);

--
-- Name: skill_packs skill_packs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skill_packs
    ADD CONSTRAINT skill_packs_pkey PRIMARY KEY (id);

--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);

--
-- Name: slack_installation slack_installation_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.slack_installation
    ADD CONSTRAINT slack_installation_pkey PRIMARY KEY (id);

--
-- Name: soul_configs soul_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.soul_configs
    ADD CONSTRAINT soul_configs_pkey PRIMARY KEY (id);

--
-- Name: soul_history soul_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.soul_history
    ADD CONSTRAINT soul_history_pkey PRIMARY KEY (id);

--
-- Name: source_auth_replay source_auth_replay_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.source_auth_replay
    ADD CONSTRAINT source_auth_replay_pkey PRIMARY KEY (event_id);

--
-- Name: task_events task_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_pkey PRIMARY KEY (id);

--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

--
-- Name: tool_calls tool_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (run_id, attempt, call_index);

--
-- Name: turn_metrics turn_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.turn_metrics
    ADD CONSTRAINT turn_metrics_pkey PRIMARY KEY (id);

--
-- Name: turn_wall_clock_configs turn_wall_clock_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.turn_wall_clock_configs
    ADD CONSTRAINT turn_wall_clock_configs_pkey PRIMARY KEY (id);

--
-- Name: unfulfilled_insights_flag unfulfilled_insights_flag_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.unfulfilled_insights_flag
    ADD CONSTRAINT unfulfilled_insights_flag_pkey PRIMARY KEY (id);

--
-- Name: web_first_turns web_first_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.web_first_turns
    ADD CONSTRAINT web_first_turns_pkey PRIMARY KEY (id);

--
-- Name: web_ui_state web_ui_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.web_ui_state
    ADD CONSTRAINT web_ui_state_pkey PRIMARY KEY (id);

--
-- Name: webhooks webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);

--
-- Name: webui_growth_profiles webui_growth_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.webui_growth_profiles
    ADD CONSTRAINT webui_growth_profiles_pkey PRIMARY KEY (principal);

--
-- Name: webui_growth_rewards webui_growth_rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.webui_growth_rewards
    ADD CONSTRAINT webui_growth_rewards_pkey PRIMARY KEY (principal, reward_key);

--
-- Name: webui_growth_rewards webui_growth_rewards_principal_run_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.webui_growth_rewards
    ADD CONSTRAINT webui_growth_rewards_principal_run_id_key UNIQUE (principal, run_id);

--
-- Name: webui_home webui_home_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.webui_home
    ADD CONSTRAINT webui_home_pkey PRIMARY KEY (id);

--
-- Name: webui_model_configs webui_model_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.webui_model_configs
    ADD CONSTRAINT webui_model_configs_pkey PRIMARY KEY (id);

--
-- Name: job_common_i1; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE UNIQUE INDEX job_common_i1 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'created'::pgboss.job_state) AND (policy = 'short'::text));

--
-- Name: job_common_i2; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE UNIQUE INDEX job_common_i2 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'active'::pgboss.job_state) AND (policy = 'singleton'::text));

--
-- Name: job_common_i3; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE UNIQUE INDEX job_common_i3 ON pgboss.job_common USING btree (name, state, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'stately'::text));

--
-- Name: job_common_i4; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE UNIQUE INDEX job_common_i4 ON pgboss.job_common USING btree (name, singleton_on, COALESCE(singleton_key, ''::text)) WHERE ((state <> 'cancelled'::pgboss.job_state) AND (singleton_on IS NOT NULL));

--
-- Name: job_common_i5; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX job_common_i5 ON pgboss.job_common USING btree (name, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));

--
-- Name: job_common_i6; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE UNIQUE INDEX job_common_i6 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'exclusive'::text));

--
-- Name: job_common_i7; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX job_common_i7 ON pgboss.job_common USING btree (name, group_id) WHERE ((state = 'active'::pgboss.job_state) AND (group_id IS NOT NULL));

--
-- Name: job_common_i8; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE UNIQUE INDEX job_common_i8 ON pgboss.job_common USING btree (name, singleton_key) WHERE ((state = ANY (ARRAY['active'::pgboss.job_state, 'retry'::pgboss.job_state, 'failed'::pgboss.job_state])) AND (policy = 'key_strict_fifo'::text));

--
-- Name: job_common_i9; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'completed'::pgboss.job_state));

--
-- Name: job_dep_parent_idx; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX job_dep_parent_idx ON pgboss.job_dependency USING btree (parent_name, parent_id);

--
-- Name: queue_stats_i1; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX queue_stats_i1 ON ONLY pgboss.queue_stats USING btree (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);

--
-- Name: queue_stats_20260822_name_captured_on_deferred_count_queued_idx; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX queue_stats_20260822_name_captured_on_deferred_count_queued_idx ON pgboss.queue_stats_20260822 USING btree (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);

--
-- Name: queue_stats_20260823_name_captured_on_deferred_count_queued_idx; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX queue_stats_20260823_name_captured_on_deferred_count_queued_idx ON pgboss.queue_stats_20260823 USING btree (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);

--
-- Name: warning_i1; Type: INDEX; Schema: pgboss; Owner: postgres
--

CREATE INDEX warning_i1 ON pgboss.warning USING btree (created_on DESC);

--
-- Name: ack_emoji_picks_org_channel_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ack_emoji_picks_org_channel_created ON public.ack_emoji_picks USING btree (org_id, channel, created_at DESC);

--
-- Name: ack_emoji_picks_org_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ack_emoji_picks_org_created ON public.ack_emoji_picks USING btree (org_id, created_at DESC, id DESC);

--
-- Name: ack_emoji_picks_org_outcome; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ack_emoji_picks_org_outcome ON public.ack_emoji_picks USING btree (org_id, outcome);

--
-- Name: adoption_facts_actor; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX adoption_facts_actor ON public.adoption_run_facts USING btree (org, principal, created_at);

--
-- Name: adoption_facts_refresh; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX adoption_facts_refresh ON public.adoption_run_facts USING btree (org, status, checked_at);

--
-- Name: adoption_facts_window; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX adoption_facts_window ON public.adoption_run_facts USING btree (org, created_at) WHERE (origin = 'human'::text);

--
-- Name: adoption_runs_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX adoption_runs_created ON public.runs USING btree (created_at, id);

--
-- Name: adoption_scenario_jobs_claim; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX adoption_scenario_jobs_claim ON public.adoption_scenario_jobs USING btree (org, taxonomy_version, state, available_at, created_at);

--
-- Name: ambient_judgments_org_container_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ambient_judgments_org_container_created ON public.ambient_judgments USING btree (org_id, container, created_at DESC);

--
-- Name: ambient_judgments_org_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ambient_judgments_org_created ON public.ambient_judgments USING btree (org_id, created_at DESC, id DESC);

--
-- Name: ambient_judgments_org_decision; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ambient_judgments_org_decision ON public.ambient_judgments USING btree (org_id, decision);

--
-- Name: announcements_org_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX announcements_org_created ON public.announcements USING btree (org_id, created_at DESC);

--
-- Name: announcements_org_window; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX announcements_org_window ON public.announcements USING btree (org_id, starts_at DESC, ends_at DESC);

--
-- Name: audit_log_by_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX audit_log_by_at ON public.audit_log USING btree (at DESC);

--
-- Name: audit_log_by_idempotency_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX audit_log_by_idempotency_key ON public.audit_log USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

--
-- Name: audit_log_by_scope_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX audit_log_by_scope_at ON public.audit_log USING btree (scope_label, at DESC);

--
-- Name: budget_spend_by_principal_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX budget_spend_by_principal_at ON public.budget_spend USING btree (principal_id, at);

--
-- Name: channel_messages_by_container; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX channel_messages_by_container ON public.channel_messages USING btree (org_id, container, ts);

--
-- Name: channel_messages_by_sub; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX channel_messages_by_sub ON public.channel_messages USING btree (org_id, container, sub, ts);

--
-- Name: channel_messages_live_by_container; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX channel_messages_live_by_container ON public.channel_messages USING btree (org_id, container) WHERE (deleted = false);

--
-- Name: channel_messages_tsv; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX channel_messages_tsv ON public.channel_messages USING gin (tsv);

--
-- Name: channel_policy_history_container; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX channel_policy_history_container ON public.channel_policy_history USING btree (org_id, container, id DESC);

--
-- Name: credential_usage_by_scope_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX credential_usage_by_scope_ts ON public.credential_usage USING btree (scope_label, ts DESC);

--
-- Name: credential_usage_by_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX credential_usage_by_ts ON public.credential_usage USING btree (ts DESC);

--
-- Name: cron_fire_log_cron_fired_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX cron_fire_log_cron_fired_idx ON public.cron_fire_log USING btree (cron_id, fired_at DESC, fire_key DESC);

--
-- Name: cron_fire_log_inline_cron_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX cron_fire_log_inline_cron_idx ON public.crons USING btree (id) WHERE (json ? 'fireLog'::text);

--
-- Name: directory_channels_lower_cid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX directory_channels_lower_cid ON public.directory_channels USING btree (org_id, lower(channel_id));

--
-- Name: directory_channels_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX directory_channels_name ON public.directory_channels USING btree (org_id, name_lc);

--
-- Name: directory_group_members_principal; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX directory_group_members_principal ON public.directory_group_members USING btree (org_id, principal_id, group_id);

--
-- Name: directory_members_lower_pid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX directory_members_lower_pid ON public.directory_members USING btree (org_id, lower(principal_id));

--
-- Name: directory_members_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX directory_members_name ON public.directory_members USING btree (org_id, display_name_lc);

--
-- Name: egress_events_by_scope_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX egress_events_by_scope_ts ON public.egress_events USING btree (scope_label, ts DESC);

--
-- Name: egress_events_by_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX egress_events_by_ts ON public.egress_events USING btree (ts DESC);

--
-- Name: environment_attachments_by_env; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX environment_attachments_by_env ON public.environment_attachments USING btree (environment_id);

--
-- Name: error_events_by_scope_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX error_events_by_scope_ts ON public.error_events USING btree (scope_label, ts DESC);

--
-- Name: error_events_by_session_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX error_events_by_session_ts ON public.error_events USING btree (session_id, ts DESC);

--
-- Name: error_events_by_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX error_events_by_ts ON public.error_events USING btree (ts DESC);

--
-- Name: file_artifacts_owner_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX file_artifacts_owner_created ON public.file_artifacts USING btree (owner_scope_id, created_at DESC, id DESC);

--
-- Name: file_artifacts_owner_path; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX file_artifacts_owner_path ON public.file_artifacts USING btree (owner_scope_id, path);

--
-- Name: file_artifacts_scope_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX file_artifacts_scope_created ON public.file_artifacts USING btree (created_in_scope, created_at DESC, id DESC) WHERE (enabled = true);

--
-- Name: idx_deliveries_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_deliveries_pending ON public.deliveries USING btree (((destination ->> 'type'::text)), created_at) WHERE (delivered_at IS NULL);

--
-- Name: idx_deliveries_recipient_thread; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_deliveries_recipient_thread ON public.deliveries USING btree (recipient_thread_ref, created_at) WHERE (recipient_thread_ref IS NOT NULL);

--
-- Name: idx_deliveries_shadow; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_deliveries_shadow ON public.deliveries USING btree (created_at) WHERE (shadow AND (delivered_at IS NULL));

--
-- Name: idx_deliveries_source_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_deliveries_source_session ON public.deliveries USING btree (((provenance ->> 'sourceSessionId'::text)), created_at) WHERE (provenance IS NOT NULL);

--
-- Name: idx_deliveries_source_thread; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_deliveries_source_thread ON public.deliveries USING btree (((provenance ->> 'sourceThreadRef'::text)), created_at) WHERE (provenance IS NOT NULL);

--
-- Name: idx_legacy_turn_intents_expiry; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_legacy_turn_intents_expiry ON public.legacy_turn_intents USING btree (expires_at);

--
-- Name: idx_legacy_turn_intents_owner_page; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_legacy_turn_intents_owner_page ON public.legacy_turn_intents USING btree (principal_id, created_at DESC, id DESC);

--
-- Name: idx_proc_scope_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_proc_scope_status ON public.process_sessions USING btree (scope_id, status);

--
-- Name: idx_run_activity_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_run_activity_created ON public.run_activity USING btree (created_at);

--
-- Name: idx_run_activity_run; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_run_activity_run ON public.run_activity USING btree (run_id, id);

--
-- Name: idx_run_signals_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_run_signals_pending ON public.run_signals USING btree (run_id) WHERE (consumed_at IS NULL);

--
-- Name: idx_runs_idempotency_prefix; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_runs_idempotency_prefix ON public.runs USING btree (idempotency_key text_pattern_ops);

--
-- Name: idx_runs_one_running_per_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_runs_one_running_per_session ON public.runs USING btree (session_id) WHERE (status = 'running'::text);

--
-- Name: idx_runs_session_active_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_runs_session_active_created ON public.runs USING btree (session_id, created_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));

--
-- Name: idx_runs_session_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_runs_session_created ON public.runs USING btree (session_id, created_at DESC);

--
-- Name: idx_runs_session_created_seq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_runs_session_created_seq ON public.runs USING btree (session_id, created_at DESC, seq DESC);

--
-- Name: idx_runs_status_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_runs_status_created ON public.runs USING btree (status, created_at);

--
-- Name: idx_runs_status_created_seq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_runs_status_created_seq ON public.runs USING btree (status, created_at, seq);

--
-- Name: idx_task_events_task; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_events_task ON public.task_events USING btree (task_id, id);

--
-- Name: idx_tasks_origin_run; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_origin_run ON public.tasks USING btree (origin_run_id, created_at, id);

--
-- Name: idx_tasks_origin_run_open; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_origin_run_open ON public.tasks USING btree (origin_run_id, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'in_progress'::text]));

--
-- Name: idx_tasks_session_open; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_session_open ON public.tasks USING btree (session_id, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'in_progress'::text]));

--
-- Name: inbound_artifact_cleanup_next; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX inbound_artifact_cleanup_next ON public.inbound_artifact_cleanup USING btree (next_attempt_at, created_at, artifact_id);

--
-- Name: inbound_artifact_cleanup_run; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX inbound_artifact_cleanup_run ON public.inbound_artifact_cleanup USING btree (run_id);

--
-- Name: memory_revisions_by_scope; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX memory_revisions_by_scope ON public.memory_revisions USING btree (scope_id, seq DESC);

--
-- Name: notification_reads_session_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX notification_reads_session_idx ON public.notification_reads USING btree (session_id);

--
-- Name: notification_user_entries_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX notification_user_entries_idx ON public.session_entries USING btree (session_id, created_at, seq) WHERE (type = 'user'::text);

--
-- Name: notification_web_deliveries_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX notification_web_deliveries_idx ON public.deliveries USING btree (((destination ->> 'target'::text)), created_at, id) WHERE (((destination ->> 'type'::text) = 'web'::text) AND (NOT shadow));

--
-- Name: session_entries_artifact_ids; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX session_entries_artifact_ids ON public.session_entries USING gin (public.session_artifact_ids(payload));

--
-- Name: session_entries_search_tsv; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX session_entries_search_tsv ON public.session_entries USING gin (search_tsv) WHERE (type = ANY (ARRAY['user'::text, 'assistant'::text, 'text'::text]));

--
-- Name: session_entries_session_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX session_entries_session_created ON public.session_entries USING btree (session_id, created_at DESC);

--
-- Name: session_entries_user_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX session_entries_user_ts ON public.session_entries USING btree (created_at) WHERE (type = 'user'::text);

--
-- Name: session_llm_requests_by_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX session_llm_requests_by_session ON public.session_llm_requests USING btree (session_id, created_at, step);

--
-- Name: sessions_by_activity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX sessions_by_activity ON public.sessions USING btree (COALESCE(last_activity, created_at) DESC, id DESC);

--
-- Name: sessions_by_scope; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX sessions_by_scope ON public.sessions USING btree (scope_id, created_at DESC);

--
-- Name: sessions_by_scope_activity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX sessions_by_scope_activity ON public.sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC);

--
-- Name: source_auth_replay_expires_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX source_auth_replay_expires_at ON public.source_auth_replay USING btree (expires_at);

--
-- Name: turn_metrics_by_run; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX turn_metrics_by_run ON public.turn_metrics USING btree (run_id);

--
-- Name: turn_metrics_by_scope_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX turn_metrics_by_scope_ts ON public.turn_metrics USING btree (scope_label, ts DESC);

--
-- Name: turn_metrics_by_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX turn_metrics_by_session ON public.turn_metrics USING btree (session_id, ts DESC);

--
-- Name: turn_metrics_by_ts; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX turn_metrics_by_ts ON public.turn_metrics USING btree (ts DESC);

--
-- Name: webui_events_principal; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX webui_events_principal ON public.webui_events USING btree (principal, at DESC);

--
-- Name: webui_events_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX webui_events_type ON public.webui_events USING btree (type, at DESC);

--
-- Name: job_common_pkey; Type: INDEX ATTACH; Schema: pgboss; Owner: postgres
--

ALTER INDEX pgboss.job_pkey ATTACH PARTITION pgboss.job_common_pkey;

--
-- Name: queue_stats_20260822_name_captured_on_deferred_count_queued_idx; Type: INDEX ATTACH; Schema: pgboss; Owner: postgres
--

ALTER INDEX pgboss.queue_stats_i1 ATTACH PARTITION pgboss.queue_stats_20260822_name_captured_on_deferred_count_queued_idx;

--
-- Name: queue_stats_20260822_pkey; Type: INDEX ATTACH; Schema: pgboss; Owner: postgres
--

ALTER INDEX pgboss.queue_stats_pkey ATTACH PARTITION pgboss.queue_stats_20260822_pkey;

--
-- Name: queue_stats_20260823_name_captured_on_deferred_count_queued_idx; Type: INDEX ATTACH; Schema: pgboss; Owner: postgres
--

ALTER INDEX pgboss.queue_stats_i1 ATTACH PARTITION pgboss.queue_stats_20260823_name_captured_on_deferred_count_queued_idx;

--
-- Name: queue_stats_20260823_pkey; Type: INDEX ATTACH; Schema: pgboss; Owner: postgres
--

ALTER INDEX pgboss.queue_stats_pkey ATTACH PARTITION pgboss.queue_stats_20260823_pkey;

--
-- Name: acl_grants acl_grants_bump; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER acl_grants_bump AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.acl_grants FOR EACH STATEMENT EXECUTE FUNCTION public.acl_grants_bump_version();

--
-- Name: job_common dlq_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

--
-- Name: job_common q_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

--
-- Name: queue queue_dead_letter_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_dead_letter_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name);

--
-- Name: schedule schedule_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;

--
-- Name: subscription subscription_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: postgres
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;

--
-- Name: cron_fire_log cron_fire_log_cron_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.cron_fire_log
    ADD CONSTRAINT cron_fire_log_cron_id_fkey FOREIGN KEY (cron_id) REFERENCES public.crons(id) ON DELETE CASCADE;

--
-- Name: cron_fire_log_reads cron_fire_log_reads_cron_id_fire_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.cron_fire_log_reads
    ADD CONSTRAINT cron_fire_log_reads_cron_id_fire_key_fkey FOREIGN KEY (cron_id, fire_key) REFERENCES public.cron_fire_log(cron_id, fire_key) ON DELETE CASCADE;

--
-- Name: environment_attachments environment_attachments_environment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.environment_attachments
    ADD CONSTRAINT environment_attachments_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id);

--
-- Name: notification_reads notification_reads_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

--
-- Name: task_events task_events_task_id_cascade_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_task_id_cascade_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE NOT VALID;

--
-- Name: tasks tasks_session_id_cascade_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_session_id_cascade_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE NOT VALID;

--
-- PostgreSQL database dump complete
--

