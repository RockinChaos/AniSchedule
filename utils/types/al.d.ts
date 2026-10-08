export type Media = {
  id: number
  idMal: number
  title: {
    romaji?: string
    english?: string
    native?: string
  }
  seasonYear?: string
  format: string
  status: string
  episodes?: number
  duration?: number
  genres?: string[]
  coverImage?: {
    extraLarge: string
    medium: string
    color: string
  }
  isAdult?: boolean
  bannerImage?: string
  nextAiringEpisode?: {
    episode: number
    airingAt: number
  }
  streamingEpisodes?: {
    title: string
    thumbnail: string
  }[]
  airingSchedule?: {
    nodes?: {
      episode: number
      airingAt: number
    }[]
  }
}

export type Query<T> = {
  data: T
}

export type PagedQuery<T> = Query<{
  Page: {
    pageInfo: {
      total: number
      perPage: number
      currentPage: number
      lastPage: number
      hasNextPage: boolean
    }
  } & T
}>
