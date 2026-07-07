import styles from './Button.module.css';
import clsx from 'clsx';

export default function Button({ children, variant = 'default', size = 'md', disabled, loading, onClick, type = 'button' }) {
  return (
    <button
      type={type}
      className={clsx(styles.btn, styles[variant], styles[size], loading && styles.loading)}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? <span className={styles.spinner} /> : null}
      {children}
    </button>
  );
}
