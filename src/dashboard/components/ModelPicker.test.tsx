// ModelPicker: the invisible-native-`<select>`-over-text pattern, pinned.
//
// THE STRUCTURE RULE (behavior oracle ChatAssistantApp.tsx:5099-5103): each
// picker is its OWN positioning context, so an overlay covers only its own label.
// A shared row-wide overlay let the model select sit on top of the agent text and
// eat every click, which made the agent impossible to pick — the shape assertions
// below exist so that regression cannot come back.
//
// THE LABEL RULE (oracle 1744-1783): option VALUES stay the full provider-routed
// ids (the provider routes by id) while the LABELS read "base (provider)", so two
// gateways serving the same base name still read distinctly.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_ACTIVE_AGENT_STATE, CHAT_AGENT_STATE } from '../contract';
import { ModelPicker, modelLabel } from './ModelPicker';
import { renderWithHarness, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const SEED: HarnessSeed = {
    models: ['modal/glm-5.3-flash', 'vultr/glm-5.3-flash'],
    providerCatalog: ['modal/glm-5.3-flash', 'vultr/glm-5.3-flash'],
    providerLabels: ['glm-5.3-flash (modal)', 'glm-5.3-flash (vultr)'],
    model: 'vultr/glm-5.3-flash',
    agents: [
        { id: 'pirate', name: 'Pirate', systemPrompt: 'Arr', messages: [], tools: [] },
        { id: 'scout', name: 'Scout', systemPrompt: 'Sweep first', messages: [], tools: [] }
    ],
    // `agent` is the cell the composer picker renders AND writes; `activeAgentId` is
    // the Agents-tab editor's selection and must not leak into the composer.
    agent: '',
    activeAgentId: null
};

describe('the label fallback', () => {
    it('strips only the prefix before the final slash', () => {
        expect(modelLabel('zai-org/GLM-5.2-NVFP4')).toBe('GLM-5.2-NVFP4');
        expect(modelLabel('deep-org/nested/coder')).toBe('coder');
        expect(modelLabel('coder')).toBe('coder');
    });
});

describe('the overlay structure', () => {
    it('gives each picker its own overlay, never one shared row-wide select', () => {
        renderWithHarness(<ModelPicker />, SEED);
        const strip = screen.getByTestId('model-picker');
        const fields = strip.querySelectorAll('.composer__pick');
        expect(fields).toHaveLength(2);
        // Agent on the LEFT, model on the RIGHT of it (oracle 5093-5168).
        const agentText = within(strip).getByTestId('agent-label');
        const modelText = within(strip).getByTestId('model-label');
        expect(agentText.compareDocumentPosition(modelText)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        for (const field of Array.from(fields)) {
            // Exactly one text line and one select per positioning context: an
            // overlay that covered its neighbour is the bug this pins.
            expect(field.querySelectorAll('.composer__pick-text')).toHaveLength(1);
            expect(field.querySelectorAll('select.composer__pick-select')).toHaveLength(1);
            expect(field.querySelector('.composer__pick-text')?.parentElement).toBe(field);
            expect(field.querySelector('select')?.parentElement).toBe(field);
        }
    });
});

describe('the model picker', () => {
    it('keeps every full id as the value and shows the provider-aligned label', async () => {
        renderWithHarness(<ModelPicker />, SEED);
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        await waitFor(() =>
            expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
                ['modal/glm-5.3-flash', 'glm-5.3-flash (modal)'],
                ['vultr/glm-5.3-flash', 'glm-5.3-flash (vultr)']
            ])
        );
        expect(select.value).toBe('vultr/glm-5.3-flash');
        // The colliding base names still read apart, and the visible line agrees
        // with the selected option.
        expect(screen.getByTestId('model-label').textContent).toBe('glm-5.3-flash (vultr)');
    });

    it('dispatches the pick through chat.model.set', async () => {
        const view = renderWithHarness(<ModelPicker />, SEED);
        await waitFor(() => expect(screen.getByTestId('model-label').textContent).toBe('glm-5.3-flash (vultr)'));
        fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'modal/glm-5.3-flash' } });
        expect(view.callsOf('chat.model.set')).toEqual(['modal/glm-5.3-flash']);
    });

    it('invents nothing when the catalog is empty: the line says so and the select is inert', () => {
        renderWithHarness(<ModelPicker />, { ...SEED, models: [], providerCatalog: [], providerLabels: [], model: '' });
        expect(screen.getByTestId('model-label').textContent).toBe('No models available');
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        expect(select.disabled).toBe(true);
        // A <select> with no options has no accessible value, so the empty catalog
        // still gets one labelled row (oracle 5157-5158).
        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['', 'No models available']
        ]);
    });

    it('prompts for a choice while the catalog has models but none is selected', () => {
        renderWithHarness(<ModelPicker />, { ...SEED, model: '' });
        expect(screen.getByTestId('model-label').textContent).toBe('Select model');
    });
});

describe('the agent picker', () => {
    it('lists the registry behind the default "None" and applies a pick through chat.agent.set', () => {
        const view = renderWithHarness(<ModelPicker />, SEED);
        const select = screen.getByTestId('agent-select') as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['', 'None'],
            ['pirate', 'Pirate'],
            ['scout', 'Scout']
        ]);
        // "None" ('' value) is the DEFAULT: no agent applies to the chat.
        expect(select.value).toBe('');
        expect(screen.getByTestId('agent-label').textContent).toBe('None');
        fireEvent.change(select, { target: { value: 'scout' } });
        expect(view.callsOf('chat.agent.set')).toEqual(['scout']);
    });

    it('clears back to None with the empty value the contract documents', () => {
        const view = renderWithHarness(<ModelPicker />, { ...SEED, agent: 'pirate' });
        expect(screen.getByTestId('agent-label').textContent).toBe('Pirate');
        fireEvent.change(screen.getByTestId('agent-select'), { target: { value: '' } });
        expect(view.callsOf('chat.agent.set')).toEqual(['']);
    });

    it('tolerates a selected agent that left the registry (the text falls back to None)', () => {
        renderWithHarness(<ModelPicker />, { ...SEED, agents: [], agent: 'ghost' });
        expect(screen.getByTestId('agent-label').textContent).toBe('None');
        expect(screen.getByTestId('agent-select') as HTMLSelectElement).not.toBeNull();
    });

    it('renders the cell its own write moves, and nothing else', async () => {
        // S2: `chat.agent` is the composer's applied prefix and the ONLY cell
        // `chat.agent.set` writes; `chat.activeAgentId` is the AGENTS-TAB editor's
        // selection (chat.agent.create / the rail's rows). Rendering the editor cell
        // made the two disagree in both directions: a pick applied an agent while the
        // select still read "None", and opening an agent in the rail silently changed
        // the composer's DISPLAY without applying it.
        const view = renderWithHarness(<ModelPicker />, { ...SEED, agent: '', activeAgentId: 'scout' });
        let select = screen.getByTestId('agent-select') as HTMLSelectElement;
        expect(select.value).toBe('');
        expect(screen.getByTestId('agent-label').textContent).toBe('None');

        fireEvent.change(select, { target: { value: 'pirate' } });
        expect(view.callsOf('chat.agent.set')).toEqual(['pirate']);
        // The write landed in the composer's own cell, and the select + text line
        // follow it.
        expect(view.read<string>(CHAT_AGENT_STATE)).toBe('pirate');
        await waitFor(() => expect(screen.getByTestId('agent-label').textContent).toBe('Pirate'));
        select = screen.getByTestId('agent-select') as HTMLSelectElement;
        expect(select.value).toBe('pirate');
        // The Agents-tab cell is untouched by a composer pick, in either direction.
        expect(view.read<string | null>(CHAT_ACTIVE_AGENT_STATE)).toBe('scout');
    });
});
