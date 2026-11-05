import "./globals.css";

export const metadata = {
  title: "Course Companion — Production",
  description: "AAU Moodle-experience student & faculty platform with AI exam drafting and rubric-locked automatic grading",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
