import type { ThemeChoice } from './theme';

const choices: { value: ThemeChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeSwitch({ value, onChange }: { value: ThemeChoice; onChange: (choice: ThemeChoice) => void }) {
  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">Appearance</legend>
      {choices.map((choice) => (
        <label key={choice.value} className="theme-switch__option">
          <input
            type="radio"
            name="theme"
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          <span>{choice.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
