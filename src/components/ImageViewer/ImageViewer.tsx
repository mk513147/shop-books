import React, { useRef, useEffect } from "react";
import {
	View,
	Image,
	Modal,
	Text,
	TouchableOpacity,
	FlatList,
	Dimensions,
} from "react-native";

import { styles } from "./ImageViewer.styles";

const { width } = Dimensions.get("window");

type Props = {
	visible: boolean;
	images: string[];
	currentIndex: number;
	onClose: () => void;
	onNext: () => void;
	onPrev: () => void;
};

export default function ImageViewer({
	visible,
	images,
	currentIndex,
	onClose,
	onNext,
	onPrev,
}: Props) {
	const flatListRef = useRef<FlatList>(null);

	useEffect(() => {
		if (visible && flatListRef.current) {
			try {
				flatListRef.current.scrollToIndex({
					index: currentIndex,
					animated: false,
				});
			} catch {}
		}
	}, [visible, currentIndex]);

	if (!images.length) return null;

	return (
		<Modal visible={visible} transparent animationType="fade">
			<View style={styles.container}>
				<FlatList
					ref={flatListRef}
					data={images}
					horizontal
					pagingEnabled
					showsHorizontalScrollIndicator={false}
					keyExtractor={(_, index) => index.toString()}
					getItemLayout={(_, index) => ({
						length: width,
						offset: width * index,
						index,
					})}
					onMomentumScrollEnd={(event) => {
						const newIndex = Math.round(
							event.nativeEvent.contentOffset.x / width,
						);

						if (newIndex > currentIndex) onNext();
						else if (newIndex < currentIndex) onPrev();
					}}
					renderItem={({ item }) => (
						<View
							style={{
								width,
								justifyContent: "center",
								alignItems: "center",
							}}
						>
							<Image
								source={{ uri: item }}
								style={styles.image}
								resizeMode="contain"
							/>
						</View>
					)}
				/>
				{/* Index Indicator */}
				<Text style={styles.indexText}>
					{currentIndex + 1} / {images.length}
				</Text>

				{/* Close */}
				<TouchableOpacity style={styles.closeButton} onPress={onClose}>
					<Text style={styles.closeText}>✕</Text>
				</TouchableOpacity>
			</View>
		</Modal>
	);
}
