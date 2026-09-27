/**
 * The driver fields, shared by adding and editing. Web's `AddDriver` form in
 * one column. The licence dates get their own group because they drive the
 * out-of-service warning, and a blank one means nothing will warn.
 */

import { ENDORSEMENT_LABEL, ENDORSEMENTS, type DriverFormValues, type Truck } from '@haulq/client';
import { Field } from '../../components/ui.tsx';

export function DriverForm({
  values,
  onChange,
  trucks,
}: {
  values: DriverFormValues;
  onChange: (values: DriverFormValues) => void;
  trucks: readonly Truck[];
}) {
  const set = (patch: Partial<DriverFormValues>) => onChange({ ...values, ...patch });

  return (
    <div className="space-y-5">
      <div className="hq-card space-y-4 p-4">
        <Field label="Full name">
          <input className="hq-input" autoCapitalize="words" value={values.fullName} onChange={(e) => set({ fullName: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input className="hq-input" type="tel" inputMode="tel" value={values.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Email" hint="Needed only to invite them to the app.">
          <input
            className="hq-input"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            value={values.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </Field>
      </div>

      <div className="hq-card space-y-4 p-4">
        <div>
          <p className="font-semibold">Licence</p>
          <p className="text-sm text-mute">Both dates drive the out-of-service warning. Blank means nothing warns you.</p>
        </div>
        <div className="grid grid-cols-[1fr_5rem] gap-3">
          <Field label="CDL number">
            <input className="hq-input num" autoCapitalize="characters" value={values.cdlNumber} onChange={(e) => set({ cdlNumber: e.target.value })} />
          </Field>
          <Field label="State">
            <input
              className="hq-input"
              maxLength={2}
              autoCapitalize="characters"
              value={values.cdlState}
              onChange={(e) => set({ cdlState: e.target.value.toUpperCase() })}
            />
          </Field>
        </div>
        <Field label="CDL expires">
          <input className="hq-input" type="date" value={values.cdlExpiresAt} onChange={(e) => set({ cdlExpiresAt: e.target.value })} />
        </Field>
        <Field label="Medical card expires">
          <input
            className="hq-input"
            type="date"
            value={values.medicalCardExpiresAt}
            onChange={(e) => set({ medicalCardExpiresAt: e.target.value })}
          />
        </Field>
      </div>

      <fieldset className="hq-card p-4">
        <legend className="sr-only">Endorsements</legend>
        <p className="font-semibold">Endorsements</p>
        <p className="mb-2 text-sm text-mute">Matched against broker requirements like “TWIC required for port pickup”.</p>
        <ul className="divide-y divide-line">
          {ENDORSEMENTS.map((key) => (
            <li key={key}>
              <label className="flex cursor-pointer items-center gap-3 py-2.5">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[--color-brand]"
                  checked={values.endorsements.includes(key)}
                  onChange={(e) =>
                    set({ endorsements: e.target.checked ? [...values.endorsements, key] : values.endorsements.filter((x) => x !== key) })
                  }
                />
                <span className="font-medium">{ENDORSEMENT_LABEL[key]}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {trucks.length > 0 && (
        <div className="hq-card p-4">
          <Field label="Usual truck" hint="Can be changed per load.">
            <select className="hq-input" value={values.defaultTruckId} onChange={(e) => set({ defaultTruckId: e.target.value })}>
              <option value="">No usual truck</option>
              {trucks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
    </div>
  );
}
