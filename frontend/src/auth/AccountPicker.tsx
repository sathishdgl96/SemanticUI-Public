export interface AccountChoice {
  label: string;
  account: string;
}

/**
 * Which Snowflake account to sign in to.
 *
 * Hidden below two entries: a dropdown with one option is a decision
 * the user does not have, and every deployment that has not configured
 * a list has exactly one.
 */
export function AccountPicker({
  accounts,
  value,
  onChange,
}: {
  accounts: AccountChoice[];
  value: string;
  onChange: (account: string) => void;
}) {
  if (accounts.length < 2) return null;
  return (
    <label className="login-field">
      <span>Account</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {accounts.map((choice) => (
          <option key={choice.account} value={choice.account}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}
