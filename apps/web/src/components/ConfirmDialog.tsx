import FormDialog from './FormDialog';

export default function ConfirmDialog({
  title,
  message,
  onClose,
  onConfirm,
  destructive = false,
}: {
  title: string;
  message: string;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
  destructive?: boolean;
}) {
  return (
    <FormDialog
      title={title}
      fields={[]}
      initial={{}}
      onClose={onClose}
      onSubmit={onConfirm}
      submitLabel={destructive ? '确认操作' : '确认'}
      description={message}
    />
  );
}
