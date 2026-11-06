// SettingsPanel — the presentational primitives the settings surface is built from.
//
// WHY A SEPARATE FILE: the pre-rebuild app defined these four as `styledComponent`s
// inside the app module (src/components/ChatAssistantApp.tsx:742-800:
// `SettingsWorkspace` / `SettingsField` / `SettingsInput` / `SettingsSelect`). The
// rebuilt skin styles everything from a stylesheet instead (styles/settings.css, all
// rules `.station`-scoped), so these are plain class-driven elements — the same split
// ComposerDeck.tsx / ModelPicker.tsx already use — and StationSettings.tsx composes
// them. Nothing here reads state or runs a command: props in, DOM out, which is what
// makes the markup assertable without a composed dashboard.
//
// THE LABEL CONTRACT (oracle 4818-4829, 4849-4858): a field is a real `<label>`
// element wrapping its control, with the caption in the leading `<span>`. A
// `<label>` around a native control is the accessible name the oracle's
// `aria-label` was duplicating, so both are emitted: the wrapper gives a mouse user
// a clickable caption, the explicit `aria-label` keeps the control's accessible name
// stable for tests and screen readers that read the label element's whole text.
import type { ReactNode } from 'react';
import type { ChangeEvent } from 'react';

/** One option of a native `<select>`, in render order. */
export type SettingsChoice = { value: string; label: string };

/** `<option>` values stay the raw command inputs; only the labels are prose. */
export type SettingsFieldProps = {
    /** Caption rendered inside the `<label>` wrapper. */
    label: string;
    /** The parity testid (`mode-field`, `provider-base-field`). */
    testId: string;
    children: ReactNode;
};

export function SettingsField({ label, testId, children }: SettingsFieldProps) {
    return (
        <label className="settings__field" data-testid={testId}>
            <span className="settings__label">{label}</span>
            {children}
        </label>
    );
}

export type SettingsSelectProps = {
    value: string;
    options: readonly SettingsChoice[];
    /** Receives the raw `event.target.value`; the caller maps it to the command input. */
    onChange: (value: string) => void;
    ariaLabel: string;
    testId: string;
    disabled?: boolean;
};

/**
 * The native select, mirrors the oracle's `SettingsSelect` (styled `select`, oracle
 * 786-800): the browser paints the popup, so `color-scheme` in tokens.css is what
 * keeps a dark station from opening a white dropdown.
 */
export function SettingsSelect({
    value,
    options,
    onChange,
    ariaLabel,
    testId,
    disabled = false
}: SettingsSelectProps) {
    return (
        <select
            className="field settings__control"
            data-testid={testId}
            value={value}
            aria-label={ariaLabel}
            disabled={disabled}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
        >
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}

export type SettingsInputProps = {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    ariaLabel: string;
    testId: string;
};

/**
 * The oracle's `SettingsInput` (styled `input`, ChatAssistantApp.tsx:769-785), typed
 * `text` and never `url` on purpose: the operator keeps a half-written base in the
 * field while editing it (the raw value is what the cell holds, :3360-3362), and a
 * URL-typed field would report invalid until the last character lands.
 */
export function SettingsInput({
    value,
    onChange,
    placeholder,
    ariaLabel,
    testId
}: SettingsInputProps) {
    return (
        <input
            className="field settings__control"
            data-testid={testId}
            type="text"
            // spellcheck off: an endpoint is not prose, and the red squiggle competes
            // with the guidance note under the field.
            spellCheck={false}
            value={value}
            placeholder={placeholder}
            aria-label={ariaLabel}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
    );
}

export type SettingsGroupProps = {
    /** Accessible name of the `role="group"` region (the buttons read as one set). */
    label: string;
    testId: string;
    children: ReactNode;
};

/** A labelled set of segmented option buttons (the example's `settings__group`). */
export function SettingsGroup({ label, testId, children }: SettingsGroupProps) {
    return (
        <div className="settings__group" role="group" aria-label={label} data-testid={testId}>
            <span className="settings__group-label">{label}</span>
            <div className="settings__options">{children}</div>
        </div>
    );
}

export type SettingsOptionProps = {
    label: string;
    /** The live value this option represents — drives `aria-pressed`, never a class juggle. */
    active: boolean;
    onSelect: () => void;
    testId: string;
};

/**
 * One segment of a group. The pressed state is colour PLUS text (the label itself),
 * so the reading never depends on the accent alone; `aria-pressed` carries it for
 * assistive tech.
 */
export function SettingsOption({ label, active, onSelect, testId }: SettingsOptionProps) {
    return (
        <button
            type="button"
            className={active ? 'btn is-active' : 'btn'}
            data-testid={testId}
            aria-pressed={active}
            onClick={onSelect}
        >
            {label}
        </button>
    );
}

export type SettingsNoteProps = {
    /**
     * The parity testid (`mode-note`, `offline-endpoint-hint`). A note is static
     * guidance, so it is a `<p>` with no interactive semantics; the oracle renders the
     * same copy in its muted `Metadata` element (ChatAssistantApp.tsx:1709-1713).
     */
    testId: string;
    children: ReactNode;
};

export function SettingsNote({ testId, children }: SettingsNoteProps) {
    return (
        <p className="settings__note" data-testid={testId}>
            {children}
        </p>
    );
}

export type SettingsWorkspaceProps = {
    /** Panel heading; omitted by a host whose region chrome already titles the panel. */
    heading?: string;
    testId?: string;
    children: ReactNode;
};

/** The scroll-safe column that holds the whole settings surface. */
export function SettingsWorkspace({
    heading,
    testId = 'settings-workspace',
    children
}: SettingsWorkspaceProps) {
    return (
        <section className="settings" data-testid={testId}>
            {heading ? (
                <h2 className="settings__title" data-testid="settings-heading">
                    {heading}
                </h2>
            ) : null}
            {children}
        </section>
    );
}
