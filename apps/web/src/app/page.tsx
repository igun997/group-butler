export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <p className="text-sm font-medium text-muted-foreground">Group Butler</p>
        <h1 className="mt-3 font-heading text-4xl font-semibold tracking-tight sm:text-5xl">
          Backend API is ready.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
          Authenticated APIs for WhatsApp capture, media, and approved outbound
          sends are available from this service.
        </p>
        <p className="mt-10 text-sm text-muted-foreground">
          Use the API routes to operate Group Butler.
        </p>
      </section>
    </main>
  );
}
