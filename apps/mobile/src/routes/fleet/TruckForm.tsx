/**
 * The truck fields, shared by adding and editing. Web's `TruckFields` on a
 * phone: one column, the capabilities as a checklist with their hints,
 * because every one of them silently hides loads when it's left off.
 */

import { EQUIPMENT_OPTIONS, TRUCK_CAPABILITIES, type TruckFormValues } from '@haulq/client';
import { Field } from '../../components/ui.tsx';

export function TruckForm({ values, onChange }: { values: TruckFormValues; onChange: (values: TruckFormValues) => void }) {
  const set = (patch: Partial<TruckFormValues>) => onChange({ ...values, ...patch });
  const number = (key: 'maxWeightLbs' | 'maxLengthFt' | 'boxHeightIn' | 'boxWidthIn', label: string, hint?: string) => (
    <Field label={label} {...(hint ? { hint } : {})}>
      <input className="hq-input num" inputMode="numeric" value={values[key]} onChange={(e) => set({ [key]: e.target.value })} />
    </Field>
  );

  return (
    <div className="space-y-5">
      <div className="hq-card space-y-4 p-4">
        <Field label="Label" hint="What you call it. “Unit 12”, “the white box”.">
          <input className="hq-input" value={values.label} onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <Field label="Equipment">
          <select className="hq-input" value={values.equipment} onChange={(e) => set({ equipment: e.target.value })}>
            {EQUIPMENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {number('maxWeightLbs', 'Max weight (lbs)')}
          {number('maxLengthFt', 'Max length (ft)')}
          {number('boxHeightIn', 'Height (in)', 'Overall, for bridges.')}
          {number('boxWidthIn', 'Width (in)', 'Overall.')}
        </div>
      </div>

      <fieldset className="hq-card p-4">
        <legend className="sr-only">What it can do</legend>
        <p className="font-semibold">What it can do</p>
        <p className="mb-2 text-sm text-mute">
          These decide which loads match this truck. Leaving one off hides the loads that need it, without saying so.
        </p>
        <ul className="divide-y divide-line">
          {TRUCK_CAPABILITIES.map((c) => (
            <li key={c.key}>
              <label className="flex cursor-pointer items-start gap-3 py-2.5">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 accent-[--color-brand]"
                  checked={values.capabilities[c.key] ?? false}
                  onChange={(e) => set({ capabilities: { ...values.capabilities, [c.key]: e.target.checked } })}
                />
                <span>
                  <span className="block font-medium">{c.label}</span>
                  <span className="block text-xs text-mute">{c.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <label className="hq-card flex cursor-pointer items-start gap-3 p-4">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 accent-[--color-brand]"
          checked={values.shortHaulExempt}
          onChange={(e) => set({ shortHaulExempt: e.target.checked })}
        />
        <span>
          <span className="block font-medium">Runs under the 150 air-mile short-haul exemption</span>
          <span className="block text-xs text-mute">
            Common for straight trucks. ELD coverage is patchy, so HaulQ falls back to the driver app for position.
          </span>
        </span>
      </label>
    </div>
  );
}
