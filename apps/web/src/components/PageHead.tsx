import Head from "next/head";

export const PageHead = ({ title }: { title: string }) => {
  const pageTitle = title
    .replaceAll("Kan.bn", "Kan-ductor")
    .replaceAll("kan.bn", "Kan-ductor");

  return (
    <Head>
      <title>{pageTitle}</title>
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, maximum-scale=1"
      />
      <link rel="manifest" href="/manifest.json" />
    </Head>
  );
};
