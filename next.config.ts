import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/apply", destination: "/application", permanent: false },
      { source: "/apply/bu", destination: "/application?campus=bu", permanent: false },
      { source: "/apply/bc", destination: "/application?campus=bc", permanent: false },
      { source: "/application/bu", destination: "/application?campus=bu", permanent: false },
      { source: "/application/bc", destination: "/application?campus=bc", permanent: false },
      { source: "/bu/application", destination: "/application?campus=bu", permanent: false },
      { source: "/bc/application", destination: "/application?campus=bc", permanent: false },
      { source: "/bu/apply", destination: "/application?campus=bu", permanent: false },
      { source: "/bc/apply", destination: "/application?campus=bc", permanent: false },
    ];
  },
};

export default nextConfig;
