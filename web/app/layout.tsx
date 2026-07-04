export const metadata = {
  title: "Meeting Assistant",
  description: "Transcriptions, summaries and insights for your meetings.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ font: "14px system-ui", margin: 0, background: "#f6f6f9", color: "#1c1c28" }}>
        {children}
      </body>
    </html>
  );
}
